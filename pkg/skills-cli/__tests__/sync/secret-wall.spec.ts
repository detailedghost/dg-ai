import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSecretWall } from "../../src/sync/secret-wall";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "secret-wall-test-"));
	tmpDirs.push(d);
	return d;
}

describe("checkSecretWall", () => {
	test("trips on a real-shape ctx7sk- secret", () => {
		const dir = withTmp();
		const file = join(dir, "config.json");
		const secret = `ctx7sk-${randomBytes(16).toString("hex")}`;
		writeFileSync(file, JSON.stringify({ mcp: { context7: { env: { CONTEXT7_API_KEY: secret } } } }));
		const hits = checkSecretWall([file]);
		expect(hits.map((h) => h.path)).toContain(file);
	});

	test("does not trip on an env-var indirection placeholder", () => {
		const dir = withTmp();
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ mcp: { context7: { env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } } } }));
		expect(checkSecretWall([file])).toEqual([]);
	});

	test("trips on an unquoted Authorization: Bearer header line", () => {
		const dir = withTmp();
		const file = join(dir, "hook.yaml");
		const token = randomBytes(30).toString("hex");
		writeFileSync(file, `headers:\n  Authorization: Bearer ${token}\n`);
		expect(checkSecretWall([file]).map((h) => h.path)).toContain(file);
	});

	test("trips on a JSON-quoted Authorization: Bearer header value", () => {
		const dir = withTmp();
		const file = join(dir, "config.json");
		const token = randomBytes(30).toString("hex");
		writeFileSync(file, JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }));
		expect(checkSecretWall([file]).map((h) => h.path)).toContain(file);
	});

	test("trips on a JWT-shaped literal", () => {
		const dir = withTmp();
		const file = join(dir, "mcp-config.json");
		const jwt = `eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.${"x".repeat(40)}`;
		writeFileSync(file, JSON.stringify({ token: jwt }));
		expect(checkSecretWall([file]).map((h) => h.path)).toContain(file);
	});

	test("does not trip on an ordinary config with no secret-shaped values", () => {
		const dir = withTmp();
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ trustedFolders: ["/tmp/ai"], statusLine: { command: "bash x.sh" } }));
		expect(checkSecretWall([file])).toEqual([]);
	});

	test("skips a path that does not exist", () => {
		expect(checkSecretWall([join(withTmp(), "missing.json")])).toEqual([]);
	});

	test("scans every path given, independent of any push-surface or tracking concept", () => {
		const dir = withTmp();
		const clean = join(dir, "clean.json");
		const dirty = join(dir, "dirty.json");
		writeFileSync(clean, JSON.stringify({ a: 1 }));
		writeFileSync(dirty, JSON.stringify({ token: `ghp_${"a".repeat(36)}` }));
		const hits = checkSecretWall([clean, dirty]).map((h) => h.path);
		expect(hits).not.toContain(clean);
		expect(hits).toContain(dirty);
	});
});
