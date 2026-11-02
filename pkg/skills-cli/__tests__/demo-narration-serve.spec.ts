import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/demo/bridge";
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

describe("serveNarrationAsset", () => {
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

describe("bridge clip limit", () => {
	test("ignores an oversized clip without writing a file", async () => {
		const job = { dir, planPath: join(dir, "p.md"), slug: "s", video: true };
		const bridge = createBridge({ job });
		await bridge.handle({
			kind: "clip",
			index: 0,
			sampleRate: 24000,
			pcm: "A".repeat(12 * 1024 * 1024),
		});
		expect(await Bun.file(join(dir, "clips", "0.f32")).exists()).toBe(false);
	});
});
