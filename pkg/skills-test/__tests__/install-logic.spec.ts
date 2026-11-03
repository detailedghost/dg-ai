import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Unit smoke tests for the install script's release resolution: the exact
 * logic that broke install (per-part release tags).
 */
import { describe, expect, test } from "bun:test";
import {
	cliBinDir,
	expectedSha256,
	cliDest,
	pickExtAsset,
	pickRelease,
	RELEASE_TAG,
	type Release,
} from "@dg/skills-cli/lib";

const asset = (name: string, url = `u/${name}`) => ({ name, browser_download_url: url });

const RELEASES: Release[] = [
	{ tag_name: "v1.2.0", draft: false, assets: [asset("dg-skills-linux-x64", "u/old-linux-x64")] },
	{ tag_name: "v1.23.0", draft: true, assets: [asset("dg-skills-linux-x64", "u/draft")] },
	{
		tag_name: "skills-v1.21.1",
		draft: false,
		assets: [asset("dg-skills-linux-x64", "u/legacy-linux-x64")],
	},
	{
		tag_name: "ext-v1.21.1",
		draft: false,
		assets: [asset("dg-ai-extension-1.21.1-chrome.zip", "u/legacy-chrome")],
	},
	{
		tag_name: "daemon-v1.21.1",
		draft: false,
		assets: [asset("dg-daemon-linux-x64", "u/legacy-daemon")],
	},
	{
		tag_name: "v1.22.0",
		draft: false,
		assets: [
			asset("dg-skills-linux-x64", "u/linux-x64"),
			asset("dg-skills-macos-arm64", "u/macos-arm64"),
			asset("dg-skills-windows-x64.exe", "u/win-x64"),
			asset("dg-ai-extension-1.22.0-chrome.zip", "u/chrome"),
			asset("dg-ai-extension-1.22.0-firefox.zip", "u/firefox"),
			asset("dg-daemon-linux-x64", "u/srv-linux-x64"),
			asset("dg-daemon-windows-x64.exe", "u/srv-win-x64"),
		],
	},
];

describe("pickRelease", () => {
	test("picks the newest vX.Y.Z by semver, not by string or list order, and skips drafts and prefixed tags", () => {
		expect(pickRelease(RELEASES)?.tag_name).toBe("v1.22.0");
	});

	test("a pin resolves the exact v<version> tag", () => {
		expect(pickRelease(RELEASES, "1.22.0")?.tag_name).toBe("v1.22.0");
		expect(pickRelease(RELEASES, "1.2.0")?.tag_name).toBe("v1.2.0");
		expect(pickRelease(RELEASES, "9.9.9")).toBeUndefined();
	});

	test("a pin never resolves a draft", () => {
		expect(pickRelease(RELEASES, "1.23.0")).toBeUndefined();
	});

	test("a pin at or below 1.21.1 falls back to the legacy prefixed tag", () => {
		expect(pickRelease(RELEASES, "1.21.1", "skills-v")?.tag_name).toBe("skills-v1.21.1");
		expect(pickRelease(RELEASES, "1.21.1")).toBeUndefined();
	});

	test("a pin above 1.21.1 never resolves a prefixed tag", () => {
		const prefixed: Release[] = [{ tag_name: "skills-v1.21.2", draft: false, assets: [] }];
		expect(pickRelease(prefixed, "1.21.2", "skills-v")).toBeUndefined();
	});

	test("RELEASE_TAG accepts only vX.Y.Z", () => {
		expect(RELEASE_TAG.test("v1.22.0")).toBe(true);
		for (const tag of ["skills-v1.22.0", "v1.22", "v1.22.0-rc1", "latest"]) {
			expect(RELEASE_TAG.test(tag)).toBe(false);
		}
	});
});

describe("pickExtAsset (extension zip from the vX.Y.Z release)", () => {
	test("chrome resolves the newest vX.Y.Z zip, not a prefixed release", () => {
		const a = pickExtAsset(RELEASES, "chrome");
		expect(a?.name).toBe("dg-ai-extension-1.22.0-chrome.zip");
		expect(a?.version).toBe("1.22.0");
	});

	test("firefox resolves its zip", () => {
		expect(pickExtAsset(RELEASES, "firefox")?.name).toContain("firefox");
	});

	test("no vX.Y.Z release → undefined", () => {
		expect(pickExtAsset([RELEASES[2]], "chrome")).toBeUndefined();
	});

	test("a pin of 1.22.0 resolves v1.22.0", () => {
		expect(pickExtAsset(RELEASES, "chrome", "1.22.0")?.version).toBe("1.22.0");
		expect(pickExtAsset(RELEASES, "chrome", "9.9.9")).toBeUndefined();
	});

	test("a pin of 1.21.1 resolves ext-v1.21.1", () => {
		const a = pickExtAsset(RELEASES, "chrome", "1.21.1");
		expect(a?.url).toBe("u/legacy-chrome");
		expect(a?.version).toBe("1.21.1");
	});
});

describe("install paths and checksum parsing", () => {
	test("cliBinDir honors DG_HOME and falls back to ~/.dg/bin", () => {
		expect(cliBinDir({ DG_HOME: "/opt/dg-home" })).toBe("/opt/dg-home/bin");
		expect(cliBinDir({})).toBe(join(homedir(), ".dg", "bin"));
		expect(cliBinDir({ DG_HOME: "" })).toBe(join(homedir(), ".dg", "bin"));
	});

	test("cliDest lands in the DG_HOME bin directory, one shim per program", () => {
		const saved = process.env.DG_HOME;
		process.env.DG_HOME = "/opt/dg-home";
		try {
			expect(cliDest("dg-agent")).toStartWith("/opt/dg-home/bin/dg-agent");
			expect(cliDest("dg-agent")).not.toBe(cliDest("dg-daemon"));
		} finally {
			if (saved === undefined) delete process.env.DG_HOME;
			else process.env.DG_HOME = saved;
		}
	});

	test("expectedSha256 reads GNU text and binary-mode lines and lowercases the hash", () => {
		const hash = "AB".repeat(32);
		const sums = `${"1".repeat(64)}  other\n${hash} *dg-skills-linux-x64\r\n`;
		expect(expectedSha256(sums, "dg-skills-linux-x64")).toBe(hash.toLowerCase());
		expect(expectedSha256(`${"2".repeat(64)}  dg-skills-linux-x64   \n`, "dg-skills-linux-x64")).toBe("2".repeat(64));
		expect(expectedSha256(sums, "dg-skills-linux")).toBeUndefined();
		expect(expectedSha256(`${"3".repeat(63)}  dg-skills-linux-x64\n`, "dg-skills-linux-x64")).toBeUndefined();
		expect(expectedSha256(`x${"3".repeat(64)}  dg-skills-linux-x64\n`, "dg-skills-linux-x64")).toBeUndefined();
	});

});
