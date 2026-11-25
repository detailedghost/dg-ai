import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionAssetName, companionDir } from "@dg/common/node/companion";
import { ensureCompanion, loadCompanion } from "../src/install/companion";
import { sha256Hex } from "../src/utils/lib";

const roots: string[] = [];

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-ensure-companion-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function bundle(files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(Bun.zstdCompressSync(await new Bun.Archive(files).bytes()));
}

function release(
	version: string,
	assets: Record<string, Uint8Array<ArrayBuffer>>,
	sums?: string,
): { fetch: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const listing =
		sums ?? Object.entries(assets).map(([name, bytes]) => `${sha256Hex(bytes)}  ${name}`).join("\n");
	const base = `https://github.com/detailedghost/dg-ai/releases/download/v${version}/`;
	const fake = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		urls.push(url);
		if (url === `${base}SHA256SUMS`) return new Response(listing);
		const asset = assets[url.slice(base.length)];
		return asset ? new Response(asset) : new Response("missing", { status: 404 });
	};
	return { fetch: fake as typeof fetch, urls };
}

describe("ensureCompanion", () => {
	test("unpacks a verified companion and returns its directory", async () => {
		const paths = { dataDir: dataDir() };
		const asset = companionAssetName("pw", "1.2.3");
		const { fetch } = release("1.2.3", { [asset]: await bundle({ "index.js": "export const marker = 1;\n" }) });
		const dir = await ensureCompanion("pw", "1.2.3", { fetch, paths });
		expect(dir).toBe(companionDir(paths, "pw", "1.2.3"));
		expect(await Bun.file(join(dir, "index.js")).text()).toBe("export const marker = 1;\n");
		expect(readdirSync(join(paths.dataDir, "companions"))).toEqual(["pw-1.2.3"]);
	});

	test("downloads only once", async () => {
		const paths = { dataDir: dataDir() };
		const asset = companionAssetName("db", "1.2.3");
		const { fetch, urls } = release("1.2.3", { [asset]: await bundle({ "index.js": "export {};\n" }) });
		await ensureCompanion("db", "1.2.3", { fetch, paths });
		const calls = urls.length;
		await ensureCompanion("db", "1.2.3", { fetch, paths });
		expect(urls.length).toBe(calls);
	});

	test("writes nothing when the sha256 does not match", async () => {
		const paths = { dataDir: dataDir() };
		const asset = companionAssetName("pw", "1.2.3");
		const real = await bundle({ "index.js": "export const real = 1;\n" });
		const tampered = await bundle({ "index.js": "export const evil = 1;\n" });
		const { fetch } = release("1.2.3", { [asset]: tampered }, `${sha256Hex(real)}  ${asset}`);
		const error = await ensureCompanion("pw", "1.2.3", { fetch, paths }).catch((caught: unknown) => caught);
		expect((error as Error).message).toContain("checksum mismatch");
		expect(existsSync(companionDir(paths, "pw", "1.2.3"))).toBe(false);
		expect(existsSync(join(paths.dataDir, "companions")) ? readdirSync(join(paths.dataDir, "companions")) : []).toEqual([]);
	});

	test("refuses a companion that SHA256SUMS does not list", async () => {
		const paths = { dataDir: dataDir() };
		const asset = companionAssetName("pw", "1.2.3");
		const { fetch } = release("1.2.3", { [asset]: await bundle({ "index.js": "export {};\n" }) }, "");
		const error = await ensureCompanion("pw", "1.2.3", { fetch, paths }).catch((caught: unknown) => caught);
		expect((error as Error).message).toContain("no entry for dg-pw-1.2.3.tar.zst");
		expect(existsSync(companionDir(paths, "pw", "1.2.3"))).toBe(false);
	});

	test("refuses a verified archive that holds more than index.js", async () => {
		const paths = { dataDir: dataDir() };
		const asset = companionAssetName("pw", "1.2.3");
		const { fetch } = release("1.2.3", { [asset]: await bundle({ "index.js": "export {};\n", "../escape.js": "x" }) });
		const error = await ensureCompanion("pw", "1.2.3", { fetch, paths }).catch((caught: unknown) => caught);
		expect((error as Error).message).toContain("must hold only index.js");
		expect(existsSync(companionDir(paths, "pw", "1.2.3"))).toBe(false);
	});

	test("throws with the download error and the manual command when the download fails", async () => {
		const paths = { dataDir: dataDir() };
		const { fetch } = release("1.2.3", {});
		const error = (await ensureCompanion("pw", "1.2.3", { fetch, paths }).catch((caught: unknown) => caught)) as Error;
		expect(error.message).toContain("HTTP 404");
		expect(error.message).toContain("dg-pw-1.2.3.tar.zst");
		expect(error.message).toContain("curl -fsSL https://github.com/detailedghost/dg-ai/releases/download/v1.2.3/dg-pw-1.2.3.tar.zst");
		expect(error.message).toContain(companionDir(paths, "pw", "1.2.3"));
	});
});

describe("loadCompanion", () => {
	test("downloads a missing companion on first use and imports it", async () => {
		const paths = { dataDir: dataDir() };
		const asset = companionAssetName("db", "1.2.3");
		const { fetch } = release("1.2.3", { [asset]: await bundle({ "index.js": "export const marker = 'downloaded';\n" }) });
		const original = globalThis.fetch;
		globalThis.fetch = fetch;
		try {
			const loaded = (await loadCompanion("db", { external: true, version: "1.2.3", paths })) as unknown as { marker: string };
			expect(loaded.marker).toBe("downloaded");
		} finally {
			globalThis.fetch = original;
		}
	});
});
