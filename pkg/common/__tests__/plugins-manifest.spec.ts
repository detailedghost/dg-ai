import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_NAME_PATTERN } from "../src/credentials-format";
import { DgCliError } from "../src/errors";
import { parseDgToml } from "../src/node/dg-toml";
import { resolvePluginConfig } from "../src/plugins/config";
import {
	decodeFrame,
	encodeFrame,
	FRAME_HEADER_BYTES,
	FRAME_MAX_PAYLOAD_BYTES,
	pluginTokenCredential,
	validateMessage,
} from "../src/plugins/contract";
import { parseManifest, permissionReport } from "../src/plugins/manifest";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "plugins");

function names(dir: string, ext: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(ext))
		.sort();
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

function caught(fn: () => unknown): DgCliError {
	try {
		fn();
	} catch (error) {
		if (error instanceof DgCliError) return error;
		throw error;
	}
	throw new Error("expected the call to throw a DgCliError");
}

function fromHex(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("parseManifest fixtures", () => {
	const valid = join(FIXTURES, "manifests", "valid");
	const invalid = join(FIXTURES, "manifests", "invalid");
	const expected = readJson<Record<string, { line: number; key: string; includes: string }>>(join(invalid, "expected.json"));

	test.each(names(valid, ".toml"))("parses valid fixture %s", (file) => {
		const manifest = parseManifest(readFileSync(join(valid, file), "utf8"), file);
		expect(manifest.name.length).toBeGreaterThan(0);
	});

	test("every invalid fixture has an expectation and every expectation has a fixture", () => {
		expect(Object.keys(expected).sort()).toEqual(names(invalid, ".toml"));
	});

	test.each(names(invalid, ".toml"))("rejects invalid fixture %s with file, line and next step", (file) => {
		const want = expected[file];
		if (!want) throw new Error(`no expectation for ${file}`);
		const error = caught(() => parseManifest(readFileSync(join(invalid, file), "utf8"), file));
		expect(error.message).toContain(`dg plugin: ${file}:${want.line}: `);
		expect(error.message).toContain(want.includes);
		expect(error.message).toContain("Next: ");
	});
});

describe("parseManifest", () => {
	test("names the line and the allowed kinds for an unknown kind", () => {
		const error = caught(() => parseManifest('name = "x"\nversion = "1.0.0"\nkind = "widget"\n[entry]\nbuiltin = "x"\n', "plugin.toml"));
		expect(error.message).toContain("plugin.toml:3");
		expect(error.message).toContain("hook, job, skill");
	});

	test("defaults a local external plugin to the ipc transport", () => {
		const manifest = parseManifest('name = "x"\nversion = "1.0.0"\nkind = "job"\n[entry]\ncommand = "x"\n', "plugin.toml");
		expect(manifest).toMatchObject({ transport: "ipc", remote: false, entry: { command: "x", args: [] } });
	});

	test("reads the declared capabilities, permissions and pin", () => {
		const text = readFileSync(join(FIXTURES, "manifests", "valid", "external-hook-ipc.toml"), "utf8");
		expect(parseManifest(text, "plugin.toml")).toMatchObject({
			capabilities: { fs_read: ["."], exec: ["git"] },
			permissions: { env: ["HOME"], credentials: ["plugin-secret-scan-token"] },
			pin: { kind: "commit", value: "0123456789abcdef0123456789abcdef01234567" },
		});
	});

	test("reports what dg enforces and what it cannot enforce", () => {
		const text = readFileSync(join(FIXTURES, "manifests", "valid", "external-hook-ipc.toml"), "utf8");
		const report = permissionReport(parseManifest(text, "plugin.toml"));
		expect(report.enforced.join(" ")).toContain("exec allowlist: git");
		expect(report.enforced.join(" ")).toContain("credentials: plugin-secret-scan-token");
		expect(report.unenforced.join(" ")).toContain("network");
		expect(report.unenforced.join(" ")).toContain("file read: .");
	});

	test("reports no enforceable limits for a built-in plugin", () => {
		const report = permissionReport(parseManifest('name = "x"\nversion = "1.0.0"\nkind = "hook"\n[entry]\nbuiltin = "x"\n', "plugin.toml"));
		expect(report.unenforced).toEqual([]);
	});
});

describe("plugin token credential", () => {
	test("is a valid credential name derived from the plugin name", () => {
		expect(pluginTokenCredential("secret-scan")).toBe("plugin-secret-scan-token");
		expect(CREDENTIAL_NAME_PATTERN.test(pluginTokenCredential("secret-scan"))).toBe(true);
	});
});

describe("resolvePluginConfig", () => {
	const remote = parseManifest(readFileSync(join(FIXTURES, "manifests", "valid", "remote-hook-http.toml"), "utf8"), "plugin.toml");
	const local = parseManifest(readFileSync(join(FIXTURES, "manifests", "valid", "external-hook-ipc.toml"), "utf8"), "plugin.toml");

	test("reads enabled, source and settings through the dg-toml reader", () => {
		const config = parseDgToml(
			'[plugins.secret-scan]\nenabled = true\nsource = "https://github.com/example/dg-secret-scan"\n[plugins.secret-scan.settings]\nlevel = "strict"\napi_token = { credential = "plugin-secret-scan-token" }\n',
			"config.toml",
		);
		expect(resolvePluginConfig(config, local, "config.toml")).toEqual({
			enabled: true,
			allowRemote: false,
			source: "https://github.com/example/dg-secret-scan",
			settings: { level: "strict", api_token: { credential: "plugin-secret-scan-token" } },
		});
	});

	test("treats a plugin with no config section as disabled", () => {
		expect(resolvePluginConfig(parseDgToml("", "config.toml"), local, "config.toml")).toMatchObject({ enabled: false, settings: {} });
	});

	test("refuses a remote manifest when config.toml does not allow remote", () => {
		const config = parseDgToml("[plugins.team-policy]\nenabled = true\n", "config.toml");
		const error = caught(() => resolvePluginConfig(config, remote, "config.toml"));
		expect(error.message).toContain("plugins.team-policy.allow_remote");
		expect(error.message).toContain("Next: ");
	});

	test("accepts a remote manifest when config.toml sets allow_remote", () => {
		const config = { ...parseDgToml("", "config.toml"), plugins: { "team-policy": { enabled: true, settings: {}, allow_remote: true } } };
		expect(resolvePluginConfig(config, remote, "config.toml")).toMatchObject({ enabled: true, allowRemote: true });
	});

	test("does not let allow_remote in config.toml enable a manifest that is not remote", () => {
		const config = { ...parseDgToml("", "config.toml"), plugins: { "secret-scan": { enabled: true, settings: {}, allow_remote: true } } };
		expect(resolvePluginConfig(config, local, "config.toml")).toMatchObject({ allowRemote: false });
	});
});

describe("validateMessage fixtures", () => {
	const valid = join(FIXTURES, "messages", "valid");
	const invalid = join(FIXTURES, "messages", "invalid");
	type Case = { route: string; direction: "request" | "response"; body: unknown; expect?: { key: string; includes: string } };

	test.each(names(valid, ".json"))("accepts valid message %s", (file) => {
		const { route, direction, body } = readJson<Case>(join(valid, file));
		expect(() => validateMessage(route, direction, body)).not.toThrow();
	});

	test.each(names(invalid, ".json"))("rejects invalid message %s naming the key", (file) => {
		const { route, direction, body, expect: want } = readJson<Case>(join(invalid, file));
		if (!want) throw new Error(`no expectation in ${file}`);
		const error = caught(() => validateMessage(route, direction, body));
		expect(error.message).toContain(`dg plugin: ${want.key}: `);
		expect(error.message).toContain(want.includes);
	});

	test("covers every v1 route in both directions", () => {
		const covered = new Set(names(valid, ".json").map((file) => file.replace(".json", "")));
		for (const route of ["hello", "hook-decide", "job-run", "job-status", "skill-describe", "health"])
			for (const direction of ["request", "response"]) expect(covered.has(`${route}-${direction}`)).toBe(true);
	});
});

describe("binary frames", () => {
	type Valid = { name: string; version: number; encoding: number; flags: number; requestId: number; payloadText?: string; payloadHex?: string; hex: string };
	type Invalid = { name: string; error: string; hex: string };
	const { valid, invalid } = readJson<{ valid: Valid[]; invalid: Invalid[] }>(join(FIXTURES, "frames", "frames.json"));

	test("uses a 12-byte header and a 1 MiB payload limit", () => {
		expect(FRAME_HEADER_BYTES).toBe(12);
		expect(FRAME_MAX_PAYLOAD_BYTES).toBe(1_048_576);
	});

	test("matches the hand-computed bytes of the smallest frame", () => {
		const frame = encodeFrame({ encoding: "json", flags: 0, requestId: 2, payload: new TextEncoder().encode("{}") });
		expect(toHex(frame)).toBe("0100000000000002000000027b7d");
	});

	test.each(valid.map((fixture) => [fixture.name, fixture] as const))("decodes and re-encodes %s byte for byte", (_name, fixture) => {
		const bytes = fromHex(fixture.hex);
		const frame = decodeFrame(bytes);
		expect(frame.version).toBe(fixture.version);
		expect(frame.requestId).toBe(fixture.requestId);
		expect(frame.flags).toBe(fixture.flags);
		expect(frame.encoding).toBe(fixture.encoding === 0 ? "json" : "msgpack");
		if (fixture.payloadText !== undefined) expect(new TextDecoder().decode(frame.payload)).toBe(fixture.payloadText);
		if (fixture.payloadHex !== undefined) expect(toHex(frame.payload)).toBe(fixture.payloadHex);
		expect(toHex(encodeFrame(frame))).toBe(fixture.hex);
	});

	test.each(invalid.map((fixture) => [fixture.name, fixture] as const))("rejects %s with its documented code", (_name, fixture) => {
		const error = caught(() => decodeFrame(fromHex(fixture.hex)));
		expect(error.message).toContain(`dg plugin: frame ${fixture.error}: `);
		expect(error.message).toContain("Next: ");
	});

	test("refuses to encode a payload over the limit", () => {
		const error = caught(() => encodeFrame({ encoding: "json", flags: 0, requestId: 1, payload: new Uint8Array(FRAME_MAX_PAYLOAD_BYTES + 1) }));
		expect(error.message).toContain("frame oversize");
	});
});
