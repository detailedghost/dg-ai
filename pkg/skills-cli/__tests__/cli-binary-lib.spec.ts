/** In-process tests for the dg program helpers, so mutation testing sees them. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveDgPaths } from "@dg/common/node";
import { join } from "node:path";
import { isPostDryRun } from "../src/thrash/index";
import {
	cliBinDir,
	compiledAssetName,
	expectedSha256,
	pickProgram,
	platformKey,
	readCurrentVersion,
	verifyReleaseAsset,
} from "../src/utils/lib";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const inits: Array<RequestInit | undefined> = [];

function serve(body: string, status = 200): string[] {
	const urls: string[] = [];
	inits.length = 0;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		urls.push(String(input));
		inits.push(init);
		return new Response(body, { status });
	}) as typeof fetch;
	return urls;
}

const BYTES = new TextEncoder().encode("fake program\n");
const HASH = new Bun.CryptoHasher("sha256").update(BYTES).digest("hex");
const NAME = "dg-linux-x64";
const SUMS_URL = "https://x/SHA256SUMS";

describe("verifyReleaseAsset", () => {
	test("passes a matching hash and fetches only SHA256SUMS", async () => {
		const urls = serve(`${HASH.toUpperCase()}  ${NAME}\n`);
		await verifyReleaseAsset(SUMS_URL, NAME, BYTES, "v1.0.0");
		expect(urls).toEqual([SUMS_URL]);
		expect(inits[0]?.headers).toEqual({ "User-Agent": "dg-ai-extension" });
	});

	test("refuses a mismatch, a missing entry and a failed download", async () => {
		serve(`${"0".repeat(64)}  ${NAME}\n`);
		await expect(verifyReleaseAsset(SUMS_URL, NAME, BYTES, "v1.0.0")).rejects.toThrow(
			`checksum mismatch for ${NAME} in v1.0.0`,
		);
		serve(`${HASH}  other\n`);
		await expect(verifyReleaseAsset(SUMS_URL, NAME, BYTES, "v1.0.0")).rejects.toThrow(
			`SHA256SUMS in v1.0.0 has no entry for ${NAME}`,
		);
		serve("nope", 404);
		await expect(verifyReleaseAsset(SUMS_URL, NAME, BYTES, "v1.0.0")).rejects.toThrow(
			"failed to download SHA256SUMS for v1.0.0: HTTP 404",
		);
	});
});

describe("expectedSha256", () => {
	test("reads text and binary-mode lines, CRLF and trailing spaces, lowercased", () => {
		const upper = "AB".repeat(32);
		expect(expectedSha256(`${"1".repeat(64)}  other\r\n${upper} *dg\r\n`, "dg")).toBe(upper.toLowerCase());
		expect(expectedSha256(`${"2".repeat(64)}  dg   \n`, "dg")).toBe("2".repeat(64));
		expect(expectedSha256(`${"1".repeat(64)}  other\n${"5".repeat(64)}  dg\n`, "dg")).toBe("5".repeat(64));
		expect(expectedSha256(`${"3".repeat(63)}  dg\n`, "dg")).toBeUndefined();
		expect(expectedSha256(`x${"3".repeat(64)}  dg\n`, "dg")).toBeUndefined();
		expect(expectedSha256(`${"3".repeat(64)}dg\n`, "dg")).toBeUndefined();
		expect(expectedSha256(`${"4".repeat(64)}  dgx\n`, "dg")).toBeUndefined();
	});
});

describe("platformKey", () => {
	const cpuinfo = (flags: string): string => {
		const dir = mkdtempSync(join(tmpdir(), "dg-cpuinfo-"));
		const file = join(dir, "cpuinfo");
		writeFileSync(file, `processor : 0\nflags : ${flags}\n`);
		return file;
	};

	test("joins the OS and architecture and names Windows windows", () => {
		expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
		expect(platformKey("win32", "x64")).toBe("windows-x64");
		expect(platformKey("win32", "arm64")).toBe("windows-arm64");
		expect(platformKey("linux", "arm64")).toBe("linux-arm64");
	});

	test("linux-x64 takes the baseline build only without avx2", () => {
		const modern = cpuinfo("fpu sse4_2 avx avx2");
		const old = cpuinfo("fpu sse4_2 avx");
		try {
			expect(platformKey("linux", "x64", modern)).toBe("linux-x64");
			expect(platformKey("linux", "x64", old)).toBe("linux-x64-baseline");
			expect(platformKey("linux", "x64", join(tmpdir(), "dg-no-such-cpuinfo"))).toBe("linux-x64");
			expect(platformKey("darwin", "x64", old)).toBe("darwin-x64");
		} finally {
			for (const file of [modern, old]) rmSync(join(file, ".."), { recursive: true, force: true });
		}
	});
});

describe("compiledAssetName", () => {
	test("is dg-<key>, with .exe for a windows key", () => {
		expect(compiledAssetName("linux-x64")).toBe("dg-linux-x64");
		expect(compiledAssetName("darwin-arm64")).toBe("dg-darwin-arm64");
		expect(compiledAssetName("windows-x64-baseline")).toBe("dg-windows-x64-baseline.exe");
	});
});

describe("pickProgram", () => {
	const rel = (tag: string, assets: string[]) => ({
		tag_name: tag,
		draft: false,
		assets: assets.map((name) => ({ name, browser_download_url: `https://x/${tag}/${name}` })),
	});
	const KEY = "linux-x64";
	const FULL = ["dg-linux-x64", "dg-darwin-arm64", "SHA256SUMS"];

	test("returns the program and SHA256SUMS urls of the newest vX.Y.Z release for the platform key", () => {
		const releases = [rel("v1.27.0", FULL), rel("v1.28.0", FULL)];
		expect(pickProgram(releases, undefined, KEY)).toEqual({
			version: "1.28.0",
			assetName: "dg-linux-x64",
			url: "https://x/v1.28.0/dg-linux-x64",
			sumsUrl: "https://x/v1.28.0/SHA256SUMS",
		});
		expect(pickProgram(releases, undefined, "darwin-arm64").assetName).toBe("dg-darwin-arm64");
	});

	test("a pin selects that release, and a missing pin names it", () => {
		const releases = [rel("v1.27.0", FULL), rel("v1.28.0", FULL)];
		expect(pickProgram(releases, "1.27.0", KEY).version).toBe("1.27.0");
		expect(() => pickProgram(releases, "1.26.9", KEY)).toThrow("no release named v1.26.9 found");
	});

	test("a release without the compiled asset names that release's bootstrap", () => {
		for (const version of ["1.2.3", "1.34.2"]) {
			expect(() => pickProgram([rel(`v${version}`, [`dg-lib-${version}.tar.gz`, "runtime.json", "SHA256SUMS"])], version, KEY)).toThrow(
				`v${version} has no dg-linux-x64: releases before the compiled dg ship a bundle; run that release's bootstrap.sh: curl -fsSL https://github.com/detailedghost/dg-ai/releases/download/v${version}/bootstrap.sh | sh`,
			);
		}
	});

	test("a release that ships another platform only is refused for this key", () => {
		expect(() => pickProgram([rel("v1.40.0", ["dg-darwin-arm64", "SHA256SUMS"])], undefined, KEY)).toThrow(
			"v1.40.0 has no dg-linux-x64",
		);
	});

	test("a release without SHA256SUMS is refused, and runtime.json is not needed", () => {
		expect(() => pickProgram([rel("v1.27.0", ["dg-linux-x64"])], undefined, KEY)).toThrow("v1.27.0 has no SHA256SUMS asset");
		expect(pickProgram([rel("v1.27.0", ["dg-linux-x64", "SHA256SUMS"])], undefined, KEY).version).toBe("1.27.0");
	});
});

describe("readCurrentVersion", () => {
	test("reads the bin/current link target, and is undefined without one", () => {
		const root = mkdtempSync(join(tmpdir(), "dg-current-version-"));
		try {
			expect(readCurrentVersion(root)).toBeUndefined();
			mkdirSync(join(root, "bin", "7.0.0"), { recursive: true });
			symlinkSync("7.0.0", join(root, "bin", "current"));
			expect(readCurrentVersion(root)).toBe("7.0.0");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to the 6.3 lib/current link, and bin/current wins when both exist", () => {
		const root = mkdtempSync(join(tmpdir(), "dg-current-version-"));
		try {
			mkdirSync(join(root, "lib", "6.3.1"), { recursive: true });
			symlinkSync("6.3.1", join(root, "lib", "current"));
			expect(readCurrentVersion(root)).toBe("6.3.1");
			mkdirSync(join(root, "bin", "7.0.0"), { recursive: true });
			symlinkSync("7.0.0", join(root, "bin", "current"));
			expect(readCurrentVersion(root)).toBe("7.0.0");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("cliBinDir", () => {
	test("uses DG_HOME, else the per-OS bin dir", () => {
		expect(cliBinDir({ DG_HOME: "/opt/dg" })).toBe("/opt/dg/bin");
		expect(cliBinDir({})).toBe(resolveDgPaths({ env: {} }).binDir);
		expect(cliBinDir({ DG_HOME: "" })).toBe(resolveDgPaths({ env: {} }).binDir);
	});
});

describe("isPostDryRun", () => {
	test("the flag or a truthy DG_THRASH_DRY_RUN makes post a dry run", () => {
		expect(isPostDryRun(["post", "u", "--dry-run"], {})).toBe(true);
		for (const value of ["1", "true", "TRUE", "yes", " yes "]) {
			expect(isPostDryRun(["post"], { DG_THRASH_DRY_RUN: value })).toBe(true);
		}
		for (const value of ["", "0", "false", "no", "11", "yess"]) {
			expect(isPostDryRun(["post"], { DG_THRASH_DRY_RUN: value })).toBe(false);
		}
		expect(isPostDryRun(["post", "--dry-runs"], {})).toBe(false);
		expect(isPostDryRun(["post"], {})).toBe(false);
	});
});
