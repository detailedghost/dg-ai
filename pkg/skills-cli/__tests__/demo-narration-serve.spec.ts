import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNarrationAssets, serveNarrationAsset } from "../src/demo/narration-assets";

let dir: string;
const previous = { HOME: process.env.HOME, DG_HOME: process.env.DG_HOME };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-serve-"));
	process.env.HOME = dir;
	process.env.DG_HOME = join(dir, "state");
	mkdirSync(join(dir, "state"), { recursive: true });
});
afterEach(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("serveNarrationAsset symlinks", () => {
	test("serves nested files and returns 404 for a symlink that leaves the asset directory", () => {
		const assets = join(dir, "assets");
		mkdirSync(join(assets, "ort"), { recursive: true });
		writeFileSync(join(assets, "ort", "a.wasm"), "wasm");
		writeFileSync(join(dir, "secret.js"), "secret");
		symlinkSync(join(dir, "secret.js"), join(assets, "leak.js"));
		expect(serveNarrationAsset(assets, "/narration/ort/a.wasm").status).toBe(200);
		expect(serveNarrationAsset(assets, "/narration/leak.js").status).toBe(404);
	});
});

describe("ensureNarrationAssets limits", () => {
	test("rejects a download whose content-length exceeds the cap", async () => {
		const fetcher = (async () =>
			new Response("x", {
				headers: { "content-length": String(65 * 1024 * 1024) },
			})) as unknown as typeof fetch;
		await expect(ensureNarrationAssets("9.9.8", { fetch: fetcher })).rejects.toThrow(
			/larger than/,
		);
	});
});

describe("serveNarrationAsset", () => {
	let root: string;
	let dir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dg-serve-asset-"));
		dir = join(root, "assets");
		mkdirSync(join(dir, "ort"), { recursive: true });
		writeFileSync(join(dir, "kokoro.js"), "// kokoro");
		writeFileSync(join(dir, "ort", "a.wasm"), "wasm");
		writeFileSync(join(root, "secret.js"), "secret");
		writeFileSync(join(dir, "x.txt"), "text");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("serves allowlisted files with their content types", () => {
		expect(
			serveNarrationAsset(dir, "/narration/kokoro.js").headers["content-type"],
		).toBe("text/javascript");
		expect(serveNarrationAsset(dir, "/narration/ort/a.wasm").status).toBe(200);
	});

	test.each([
		["encoded parent traversal", "/narration/..%2fsecret.js"],
		["encoded double parent traversal", "/narration/..%2f..%2fetc%2fpasswd.js"],
		["dot-dot segment inside a path", "/narration/ort/%2e%2e/%2e%2e/secret.js"],
		["encoded absolute path", "/narration/%2Fetc%2Fx.js"],
		["lone percent", "/narration/%"],
		["extension outside the allowlist", "/narration/x.txt"],
		["path outside the narration prefix", "/other/kokoro.js"],
	])("returns 404 for %s", (_label, pathname) => {
		expect(serveNarrationAsset(dir, pathname).status).toBe(404);
	});
});
