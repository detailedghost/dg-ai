import { describe, expect, it } from "bun:test";
import {
	CREDENTIAL_MAX_VALUE_BYTES,
	credentialNameInPrefix,
	isInjectionEnvName,
	isReservedCredentialPrefix,
	RESERVED_CREDENTIAL_PREFIXES,
	validateCredentialGrantPrefix,
	validateCredentialMeta,
	validateCredentialName,
	validateCredentialsCliRequest,
	validateCredentialValue,
} from "../src/index";

describe("validateCredentialName", () => {
	it.each([
		"my-service/datadog",
		"my-service/relay/dev",
		"a",
		"x.y_z-1",
	])("accepts %p", (name) => {
		expect(validateCredentialName(name)).toBe(name);
	});

	it.each(["", "/lead", "-lead", "has space", "x".repeat(129), 1])(
		"rejects %p",
		(name) => {
			expect(() => validateCredentialName(name)).toThrow(/credential name must be/);
		},
	);

	it("folds letter case so every spelling is one credential", () => {
		expect(validateCredentialName("Phone-Vault/2026-W46")).toBe("phone-vault/2026-w46");
		expect(validateCredentialName("WARREN-PROBE")).toBe("warren-probe");
		expect(validateCredentialName("Foo")).toBe(validateCredentialName("FOO"));
		expect(validateCredentialName("X".repeat(128))).toBe("x".repeat(128));
		expect(validateCredentialGrantPrefix("Phone-Vault")).toBe("phone-vault");
		expect(() => validateCredentialGrantPrefix(1)).toThrow(/credential grant prefix must be/);
		expect(() => validateCredentialGrantPrefix("")).toThrow(/credential grant prefix must be/);
		expect(credentialNameInPrefix("Phone-Vault/2026-W46", "phone-vault")).toBe(true);
		expect(credentialNameInPrefix("phone-vault/2026-w46", "Phone-Vault")).toBe(true);
		expect(credentialNameInPrefix("phone-vault-extra", "phone-vault")).toBe(false);
	});
});

describe("validateCredentialValue", () => {
	it("rejects empty and oversized values without echoing them", () => {
		expect(() => validateCredentialValue("")).toThrow();
		const big = "s".repeat(CREDENTIAL_MAX_VALUE_BYTES + 1);
		try {
			validateCredentialValue(big);
			throw new Error("expected a failure");
		} catch (error) {
			expect(String(error)).not.toContain("sss");
		}
	});
});

describe("validateCredentialMeta", () => {
	it("keeps reserved fields and free-form JSON", () => {
		const meta = {
			provider: "example",
			site: "eu",
			scopes: ["read", "write"],
			expiresAt: "2030-01-01T00:00:00.000Z",
			createdBy: "fixture",
			note: "rotate yearly",
			region: { primary: "eu" },
		};
		expect(validateCredentialMeta(meta)).toEqual(meta);
	});

	it.each([
		{ value: "x" },
		{ clientSecret: "x" },
		{ token: "x" },
		{ Password: "x" },
		{ list: [{ apiToken: "x" }] },
		{ provider: 1 },
		{ scopes: "read" },
		{ expiresAt: "soon" },
	])("rejects %p", (meta) => {
		expect(() => validateCredentialMeta(meta)).toThrow();
	});
});

describe("validateCredentialMeta non-objects", () => {
	it("rejects null and arrays", () => {
		expect(() => validateCredentialMeta(null)).toThrow();
		expect(() => validateCredentialMeta([])).toThrow();
	});
});

describe("validateCredentialsCliRequest", () => {
	const base = { type: "cli-credentials-request", requestId: "r-1" };

	it.each([
		{ operation: "list" },
		{ operation: "get", name: "consumer/example" },
		{ operation: "delete", name: "consumer/example" },
		{ operation: "set", name: "consumer/example", value: "v", meta: {} },
		{ operation: "grant", prefix: "my-service" },
		{ operation: "revoke", prefix: "my-service" },
		{ operation: "grant-list" },
		{ operation: "list", grant: { prefix: "my-service", token: "t" } },
	])("accepts %p", (fields) => {
		expect(validateCredentialsCliRequest({ ...base, ...fields })).toMatchObject(
			fields,
		);
	});

	it.each([
		{ operation: "print" },
		{ operation: "list", value: "v" },
		{ operation: "get" },
		{ operation: "set", name: "consumer/example", meta: {} },
		{ operation: "set", name: "consumer/example", value: "v" },
		{ operation: "list", requestId: "" },
		{ operation: "grant", prefix: "has/slash" },
		{ operation: "revoke" },
		{ operation: "list", grant: { prefix: "my-service" } },
		{ operation: "list", grant: { prefix: "bad prefix", token: "t" } },
		{ operation: "list", grant: { prefix: "a", token: "t", extra: 1 } },
	])("rejects %p", (fields) => {
		expect(() =>
			validateCredentialsCliRequest({ ...base, ...fields }),
		).toThrow();
	});

	it("stores mixed-case names and grant prefixes in lowercase", () => {
		const set = validateCredentialsCliRequest({
			...base,
			operation: "set",
			name: "Phone-Vault/2026-W46",
			value: "v",
			meta: {},
		});
		expect(set.name).toBe("phone-vault/2026-w46");
		const grant = validateCredentialsCliRequest({ ...base, operation: "grant", prefix: "Phone-Vault" });
		expect(grant.prefix).toBe("phone-vault");
		const authed = validateCredentialsCliRequest({
			...base,
			operation: "get",
			name: "Phone-Vault/2026-W46",
			grant: { prefix: "Phone-Vault", token: "t" },
		});
		expect(authed.name).toBe("phone-vault/2026-w46");
		expect(authed.grant?.prefix).toBe("phone-vault");
	});
});

describe("RESERVED_CREDENTIAL_PREFIXES", () => {
	it.each(["pw", "extension", "phone-friend", "phone-vault", "db"])("reserves the tool prefix %s", (prefix) => {
		expect(RESERVED_CREDENTIAL_PREFIXES).toContain(prefix);
	});

	it("matches a reserved prefix in any letter case and nothing else", () => {
		expect(isReservedCredentialPrefix("pw")).toBe(true);
		expect(isReservedCredentialPrefix("DB")).toBe(true);
		expect(isReservedCredentialPrefix("phone-vault")).toBe(true);
		expect(isReservedCredentialPrefix("bot")).toBe(false);
		expect(isReservedCredentialPrefix("pw2")).toBe(false);
	});
});

describe("isInjectionEnvName", () => {
	it.each([
		"LD_PRELOAD",
		"ld_library_path",
		"NODE_OPTIONS",
		"PATH",
		"Home",
		"GIT_DIR",
		"HTTPS_PROXY",
		"BASH_ENV",
		"GLIBC_TUNABLES",
		"openssl_conf",
		"OPENSSL_ENGINES",
		"SSLKEYLOGFILE",
		"NODE_TLS_REJECT_UNAUTHORIZED",
		"IFS",
		"HOSTALIASES",
		"LOCPATH",
		"NLSPATH",
		"NPM_CONFIG_REGISTRY",
		"npm_config_prefix",
	])(
		"matches %p",
		(name) => {
			expect(isInjectionEnvName(name)).toBe(true);
		},
	);

	it.each(["API_KEY", "TOKEN", "DATADOG_API_KEY", "PATHS", "MY_HOME"])("does not match %p", (name) => {
		expect(isInjectionEnvName(name)).toBe(false);
	});
});
