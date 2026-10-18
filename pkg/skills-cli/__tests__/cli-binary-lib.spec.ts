/** In-process tests for the dg-skills binary helpers, so mutation testing sees them. */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPostDryRun } from "../src/thrash/index";
import { cliBinDir, cliDest, cliVersionFile, expectedSha256, pickCliAsset, verifyCliChecksum } from "../src/utils/lib";

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

const BYTES = new TextEncoder().encode("fake binary\n");
const HASH = new Bun.CryptoHasher("sha256").update(BYTES).digest("hex");
const ASSET = { name: "dg-skills-linux-x64", url: "https://x/bin", version: "1.0.0", sumsUrl: "https://x/SHA256SUMS" };

describe("verifyCliChecksum", () => {
	test("passes a matching hash and fetches only SHA256SUMS", async () => {
		const urls = serve(`${HASH.toUpperCase()}  dg-skills-linux-x64\n`);
		await verifyCliChecksum(ASSET, BYTES, "v1.0.0");
		expect(urls).toEqual(["https://x/SHA256SUMS"]);
		expect(inits[0]?.headers).toEqual({ "User-Agent": "dg-ai-extension" });
	});

	test("skips the check when the release has no SHA256SUMS", async () => {
		const urls = serve("unused");
		await verifyCliChecksum({ ...ASSET, sumsUrl: undefined }, BYTES, "v1.0.0");
		expect(urls).toEqual([]);
	});

	test("refuses a mismatch, a missing entry and a failed download", async () => {
		serve(`${"0".repeat(64)}  dg-skills-linux-x64\n`);
		await expect(verifyCliChecksum(ASSET, BYTES, "v1.0.0")).rejects.toThrow(
			"checksum mismatch for dg-skills-linux-x64 in v1.0.0",
		);
		serve(`${HASH}  other\n`);
		await expect(verifyCliChecksum(ASSET, BYTES, "v1.0.0")).rejects.toThrow(
			"SHA256SUMS in v1.0.0 has no entry for dg-skills-linux-x64",
		);
		serve("nope", 404);
		await expect(verifyCliChecksum(ASSET, BYTES, "v1.0.0")).rejects.toThrow(
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

describe("pickCliAsset", () => {
	const spec = { binaryName: "dg-skills", tagPrefix: "skills-v" };
	const rel = (assets: string[]) => [
		{ tag_name: "skills-v1.2.3", draft: false, assets: assets.map((name) => ({ name, browser_download_url: `https://x/${name}` })) },
	];

	test("carries the SHA256SUMS url from the same release", () => {
		expect(pickCliAsset(rel(["dg-skills-linux-x64", "SHA256SUMS"]), spec, "linux", "x64")).toEqual({
			name: "dg-skills-linux-x64",
			url: "https://x/dg-skills-linux-x64",
			version: "1.2.3",
			sumsUrl: "https://x/SHA256SUMS",
		});
		expect(pickCliAsset(rel(["dg-skills-linux-x64"]), spec, "linux", "x64")).toEqual({
			name: "dg-skills-linux-x64",
			url: "https://x/dg-skills-linux-x64",
			version: "1.2.3",
		});
	});
});

describe("cliBinDir", () => {
	test("uses DG_HOME, else ~/.dg", () => {
		expect(cliBinDir({ DG_HOME: "/opt/dg" })).toBe("/opt/dg/bin");
		expect(cliBinDir({})).toBe(join(homedir(), ".dg", "bin"));
		expect(cliBinDir({ DG_HOME: "" })).toBe(join(homedir(), ".dg", "bin"));
	});

	test("cliDest and cliVersionFile follow DG_HOME", () => {
		const saved = process.env.DG_HOME;
		process.env.DG_HOME = "/opt/dg";
		try {
			expect(cliDest("dg-agent")).toBe(`/opt/dg/bin/dg-agent${process.platform === "win32" ? ".exe" : ""}`);
			expect(cliVersionFile("dg-agent")).toBe("/opt/dg/bin/.dg-agent.version");
		} finally {
			if (saved === undefined) delete process.env.DG_HOME;
			else process.env.DG_HOME = saved;
		}
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
