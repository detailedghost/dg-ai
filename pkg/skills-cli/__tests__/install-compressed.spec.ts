import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installCompiled, versionProgramPath } from "../src/install/compiled";
import { readCurrent } from "../src/install/current";
import { compiledAssetName, pickProgram, platformKey } from "../src/utils/lib";
import { fakeProgramScript, RELEASE_BASE, type Scratch, scratch, sha256, stubFetch } from "./release-fixtures";

const POSIX = process.platform !== "win32";
const KEY = "linux-x64";
const ALL_KEYS = [
	"linux-x64",
	"linux-x64-baseline",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
	"windows-x64-baseline",
	"windows-arm64",
];

let box: Scratch | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
	box?.cleanup();
	box = undefined;
});

const rel = (tag: string, assets: string[]) => ({
	tag_name: tag,
	draft: false,
	assets: assets.map((name) => ({ name, browser_download_url: `https://x/${tag}/${name}` })),
});

describe("pickProgram with compressed assets", () => {
	test("prefers the .zst asset and returns the zstd encoding with the SHA256SUMS url", () => {
		const picked = pickProgram([rel("v1.0.0", ["dg-linux-x64", "dg-linux-x64.zst", "dg-linux-x64.gz", "SHA256SUMS"])], undefined, KEY, {
			compressed: true,
		});
		expect(picked).toEqual({
			version: "1.0.0",
			assetName: "dg-linux-x64.zst",
			url: "https://x/v1.0.0/dg-linux-x64.zst",
			encoding: "zstd",
			sumsUrl: "https://x/v1.0.0/SHA256SUMS",
		});
	});

	test("falls back to .gz when there is no .zst", () => {
		const picked = pickProgram([rel("v1.0.0", ["dg-linux-x64", "dg-linux-x64.gz", "SHA256SUMS"])], undefined, KEY, { compressed: true });
		expect([picked.encoding, picked.assetName]).toEqual(["gzip", "dg-linux-x64.gz"]);
	});

	test("falls back to the raw asset when no compressed asset exists", () => {
		const picked = pickProgram([rel("v1.0.0", ["dg-linux-x64", "SHA256SUMS"])], undefined, KEY, { compressed: true });
		expect([picked.encoding, picked.assetName, picked.url]).toEqual(["raw", "dg-linux-x64", "https://x/v1.0.0/dg-linux-x64"]);
	});

	test("compressed false takes the raw asset even when .zst exists", () => {
		const picked = pickProgram([rel("v1.0.0", ["dg-linux-x64", "dg-linux-x64.zst", "SHA256SUMS"])], undefined, KEY, { compressed: false });
		expect([picked.encoding, picked.assetName]).toEqual(["raw", "dg-linux-x64"]);
	});

	test("a windows key keeps .exe before the compression suffix", () => {
		const picked = pickProgram(
			[rel("v1.0.0", ["dg-windows-x64.exe", "dg-windows-x64.exe.zst", "SHA256SUMS"])],
			undefined,
			"windows-x64",
			{ compressed: true },
		);
		expect(picked.assetName).toBe("dg-windows-x64.exe.zst");
	});

	test("a compressed asset without the raw asset is still refused with the bootstrap hint", () => {
		expect(() => pickProgram([rel("v1.0.0", ["dg-linux-x64.zst", "SHA256SUMS"])], undefined, KEY, { compressed: true })).toThrow(
			"v1.0.0 has no dg-linux-x64",
		);
	});
});

const ASSET_SUFFIX = { zstd: ".zst", gzip: ".gz", raw: "" } as const;

function compressedRelease(version: string, encoding: "zstd" | "gzip" | "raw", body = fakeProgramScript(version), served: Uint8Array | string = body) {
	const raw = compiledAssetName(platformKey());
	const assetName = `${raw}${ASSET_SUFFIX[encoding]}`;
	const url = `${RELEASE_BASE}/v${version}/${assetName}`;
	const sumsUrl = `${RELEASE_BASE}/v${version}/SHA256SUMS`;
	const sums = `${sha256(body)}  ${raw}\n${sha256(typeof served === "string" ? served : served)}  ${assetName}\n`;
	const stub = stubFetch({ [url]: served, [sumsUrl]: sums });
	restore = stub.restore;
	return { picked: { version, assetName, url, encoding, sumsUrl }, calls: stub.calls, raw };
}

describe("installCompiled with compressed assets", () => {
	test.skipIf(!POSIX)("downloads the .zst, decompresses it and installs the raw program", async () => {
		box = scratch("zst");
		const body = fakeProgramScript("7.0.0");
		const { picked, calls } = compressedRelease("7.0.0", "zstd", body, Bun.zstdCompressSync(body));
		const path = await installCompiled(box.root, picked);
		expect(path).toBe(versionProgramPath(box.root, "7.0.0"));
		expect(readFileSync(path, "utf8")).toBe(body);
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
		expect(calls.some((url) => url.endsWith(".zst"))).toBe(true);
		expect(calls.some((url) => url.endsWith("dg-linux-x64"))).toBe(false);
	});

	test.skipIf(!POSIX)("downloads the .gz, decompresses it and installs the raw program", async () => {
		box = scratch("gz");
		const body = fakeProgramScript("7.0.0");
		const { picked } = compressedRelease("7.0.0", "gzip", body, Bun.gzipSync(body));
		const path = await installCompiled(box.root, picked);
		expect(readFileSync(path, "utf8")).toBe(body);
	});

	test.skipIf(!POSIX)("verifies the raw sha256 after decompression and installs nothing on a mismatch", async () => {
		box = scratch("zst-sum");
		const listed = fakeProgramScript("7.0.0");
		const served = fakeProgramScript("7.0.0", undefined, 0) + "# tampered\n";
		const { picked } = compressedRelease("7.0.0", "zstd", listed, Bun.zstdCompressSync(served));
		await expect(installCompiled(box.root, picked)).rejects.toThrow(/checksum mismatch for dg-linux-x64 /);
		expect(existsSync(join(box.root, "bin", "7.0.0"))).toBe(false);
		expect(readCurrent(box.root, "bin")).toBeUndefined();
	});

	test.skipIf(!POSIX)("a corrupt .zst installs nothing and links nothing", async () => {
		box = scratch("zst-bad");
		const { picked } = compressedRelease("7.0.0", "zstd", fakeProgramScript("7.0.0"), new Uint8Array([1, 2, 3, 4]));
		await expect(installCompiled(box.root, picked)).rejects.toThrow(/dg-linux-x64\.zst/);
		expect(existsSync(join(box.root, "bin", "7.0.0"))).toBe(false);
		expect(readCurrent(box.root, "bin")).toBeUndefined();
	});

	test.skipIf(!POSIX)("a raw pick still installs without decompression", async () => {
		box = scratch("raw");
		const { picked } = compressedRelease("7.0.0", "raw");
		const path = await installCompiled(box.root, picked);
		expect(readFileSync(path, "utf8")).toBe(fakeProgramScript("7.0.0"));
	});
});

describe("every platform key resolves a compressed asset", () => {
	test("all eight keys pick .zst when the release ships it", () => {
		const names = ALL_KEYS.flatMap((key) => [compiledAssetName(key), `${compiledAssetName(key)}.zst`]).concat("SHA256SUMS");
		for (const key of ALL_KEYS) {
			expect(pickProgram([rel("v1.0.0", names)], undefined, key, { compressed: true }).assetName).toBe(`${compiledAssetName(key)}.zst`);
		}
	});
});
