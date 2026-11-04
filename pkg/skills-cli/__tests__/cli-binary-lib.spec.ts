/** In-process tests for the dg-skills binary helpers, so mutation testing sees them. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveDgPaths } from "@dg/common/node";
import { join } from "node:path";
import { isPostDryRun } from "../src/thrash/index";
import {
	cliBinDir,
	cliDest,
	expectedSha256,
	pickBundle,
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

const BYTES = new TextEncoder().encode("fake bundle\n");
const HASH = new Bun.CryptoHasher("sha256").update(BYTES).digest("hex");
const NAME = "dg-lib-1.0.0.tar.gz";
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

describe("pickBundle", () => {
	const rel = (tag: string, assets: string[]) => ({
		tag_name: tag,
		draft: false,
		assets: assets.map((name) => ({ name, browser_download_url: `https://x/${tag}/${name}` })),
	});
	const FULL = (version: string) => [`dg-lib-${version}.tar.gz`, "SHA256SUMS", "runtime.json"];

	test("returns the bundle and SHA256SUMS urls of the newest vX.Y.Z release", () => {
		const releases = [rel("v1.27.0", FULL("1.27.0")), rel("v1.28.0", FULL("1.28.0"))];
		expect(pickBundle(releases)).toEqual({
			version: "1.28.0",
			assetName: "dg-lib-1.28.0.tar.gz",
			url: "https://x/v1.28.0/dg-lib-1.28.0.tar.gz",
			sumsUrl: "https://x/v1.28.0/SHA256SUMS",
		});
	});

	test("a pin selects that release, and a missing pin names it", () => {
		const releases = [rel("v1.27.0", FULL("1.27.0")), rel("v1.28.0", FULL("1.28.0"))];
		expect(pickBundle(releases, "1.27.0").version).toBe("1.27.0");
		expect(() => pickBundle(releases, "1.26.9")).toThrow("no release named v1.26.9 found");
	});

	test("a release without a dg-lib asset is pre-bundle at any version and names that release's bootstrap", () => {
		for (const version of ["1.2.3", "1.34.2"]) {
			expect(() => pickBundle([rel(`v${version}`, ["dg-skills-linux-x64", "SHA256SUMS"])], version)).toThrow(
				`releases before the dg-lib bundle ship compiled binaries; run that release's bootstrap.sh: curl -fsSL https://github.com/detailedghost/dg-ai/releases/download/v${version}/bootstrap.sh | sh`,
			);
		}
	});

	test("the newest release without a dg-lib asset is also reported as pre-bundle", () => {
		expect(() => pickBundle([rel("v1.40.0", ["dg-skills-linux-x64"])])).toThrow(
			"releases before the dg-lib bundle ship compiled binaries",
		);
	});

	test("a bundle release without SHA256SUMS or runtime.json is refused", () => {
		expect(() => pickBundle([rel("v1.27.0", ["dg-lib-1.27.0.tar.gz", "runtime.json"])])).toThrow("SHA256SUMS");
		expect(() => pickBundle([rel("v1.27.0", ["dg-lib-1.27.0.tar.gz", "SHA256SUMS"])])).toThrow("runtime.json");
	});
});

describe("readCurrentVersion", () => {
	test("reads the lib/current link target, and is undefined without one", () => {
		const root = mkdtempSync(join(tmpdir(), "dg-current-version-"));
		try {
			expect(readCurrentVersion(root)).toBeUndefined();
			mkdirSync(join(root, "lib", "1.27.0"), { recursive: true });
			symlinkSync("1.27.0", join(root, "lib", "current"));
			expect(readCurrentVersion(root)).toBe("1.27.0");
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

	test("cliDest follows DG_HOME and names the shim", () => {
		const saved = process.env.DG_HOME;
		process.env.DG_HOME = "/opt/dg";
		try {
			expect(cliDest("dg-agent")).toBe(`/opt/dg/bin/dg-agent${process.platform === "win32" ? ".cmd" : ""}`);
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
