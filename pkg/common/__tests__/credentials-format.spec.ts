import { describe, expect, it } from "bun:test";
import {
	CREDENTIAL_MAX_VALUE_BYTES,
	validateCredentialMeta,
	validateCredentialName,
	validateCredentialsCliRequest,
	validateCredentialValue,
} from "../src/index";

describe("validateCredentialName", () => {
	it.each([
		"channel-review/datadog",
		"channel-review/relay/dev",
		"a",
		"x.y_z-1",
	])("accepts %p", (name) => {
		expect(validateCredentialName(name)).toBe(name);
	});

	it.each(["", "Upper", "/lead", "-lead", "has space", "x".repeat(129), 1])(
		"rejects %p",
		(name) => {
			expect(() => validateCredentialName(name)).toThrow();
		},
	);
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
		{ operation: "grant", prefix: "channel-review" },
		{ operation: "revoke", prefix: "channel-review" },
		{ operation: "grant-list" },
		{ operation: "list", grant: { prefix: "channel-review", token: "t" } },
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
		{ operation: "list", grant: { prefix: "channel-review" } },
		{ operation: "list", grant: { prefix: "Bad", token: "t" } },
		{ operation: "list", grant: { prefix: "a", token: "t", extra: 1 } },
	])("rejects %p", (fields) => {
		expect(() =>
			validateCredentialsCliRequest({ ...base, ...fields }),
		).toThrow();
	});
});
