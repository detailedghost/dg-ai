import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Unit smoke tests for the install script's release-asset resolution — the
 * exact logic that broke install (per-part release tags) and the platform→
 * binary mapping the release matrix and bootstrap scripts must agree on.
 */
import { describe, expect, test } from "bun:test";
import {
	cliBinDir,
	expectedSha256,
	cliAssetName,
	cliDest,
	cliVersionFile,
	pickCliAsset,
	pickExtAsset,
	pickRelease,
	RELEASE_TAG,
	type Release,
} from "@dg/skills-cli/lib";
import { SUPPORTED_PLATFORMS } from "./supported-platforms";

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

const SKILLS_SPEC = { binaryName: "dg-skills" };
const DAEMON_SPEC = { binaryName: "dg-daemon" };

describe("cliAssetName", () => {
	for (const { platform, arch, assetName } of SUPPORTED_PLATFORMS) {
		const expected = assetName["dg-skills"];
		test(`${platform}/${arch} → ${expected}`, () => {
			expect(cliAssetName("dg-skills", platform, arch)).toBe(expected);
		});
	}

	test("unsupported OS/arch → undefined", () => {
		expect(cliAssetName("dg-skills", "aix", "x64")).toBeUndefined();
		expect(cliAssetName("dg-skills", "linux", "mips")).toBeUndefined();
	});
});

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

describe("pickCliAsset (binary from the vX.Y.Z release)", () => {
	test("linux/x64 resolves the newest vX.Y.Z binary, not a prefixed one", () => {
		const a = pickCliAsset(RELEASES, SKILLS_SPEC, "linux", "x64");
		expect(a?.name).toBe("dg-skills-linux-x64");
		expect(a?.version).toBe("1.22.0");
		expect(a?.url).toBe("u/linux-x64");
	});

	test("platform with no matching asset in the release → undefined", () => {
		// linux/arm64 isn't in the fixture's asset list
		expect(
			pickCliAsset(RELEASES, SKILLS_SPEC, "linux", "arm64"),
		).toBeUndefined();
	});

	test("a pin of 1.22.0 resolves v1.22.0", () => {
		const a = pickCliAsset(RELEASES, { ...SKILLS_SPEC, version: "1.22.0" }, "linux", "x64");
		expect(a?.version).toBe("1.22.0");
		expect(a?.url).toBe("u/linux-x64");
	});

	test("a pin of 1.21.1 resolves the skills-v and daemon-v tags", () => {
		const skills = pickCliAsset(RELEASES, { ...SKILLS_SPEC, version: "1.21.1" }, "linux", "x64");
		const daemon = pickCliAsset(RELEASES, { ...DAEMON_SPEC, version: "1.21.1" }, "linux", "x64");
		expect(skills?.url).toBe("u/legacy-linux-x64");
		expect(skills?.version).toBe("1.21.1");
		expect(daemon?.url).toBe("u/legacy-daemon");
	});

	test("a pin with no matching release resolves undefined, even though a newer one exists", () => {
		expect(
			pickCliAsset(RELEASES, { ...SKILLS_SPEC, version: "9.9.9" }, "linux", "x64"),
		).toBeUndefined();
	});
});

describe("the fetcher is generalized over binaryName", () => {
	test("cliAssetName builds a dg-daemon name for every supported platform", () => {
		for (const { platform, arch, assetName } of SUPPORTED_PLATFORMS) {
			expect(cliAssetName("dg-daemon", platform, arch)).toBe(
				assetName["dg-daemon"],
			);
		}
	});

	test("pickCliAsset resolves dg-daemon from the same vX.Y.Z release as dg-skills", () => {
		const picked = pickCliAsset(RELEASES, DAEMON_SPEC, "linux", "x64");
		expect(picked?.name).toBe("dg-daemon-linux-x64");
		expect(picked?.version).toBe("1.22.0");
		expect(picked?.url).toBe("u/srv-linux-x64");
	});

	test("a platform with no published dg-daemon asset resolves undefined rather than a skills binary", () => {
		expect(
			pickCliAsset(RELEASES, DAEMON_SPEC, "darwin", "arm64"),
		).toBeUndefined();
	});

	test("cliDest and cliVersionFile are per-binary, so one install cannot overwrite the other", () => {
		expect(cliDest("dg-skills")).not.toBe(cliDest("dg-daemon"));
		expect(cliDest("dg-daemon")).toContain("dg-daemon");
		expect(cliVersionFile("dg-daemon")).toContain(".dg-daemon.version");
		expect(cliVersionFile("dg-skills")).toContain(".dg-skills.version");
	});

	test("cliBinDir honors DG_HOME and falls back to ~/.dg/bin", () => {
		expect(cliBinDir({ DG_HOME: "/opt/dg-home" })).toBe("/opt/dg-home/bin");
		expect(cliBinDir({})).toBe(join(homedir(), ".dg", "bin"));
		expect(cliBinDir({ DG_HOME: "" })).toBe(join(homedir(), ".dg", "bin"));
	});

	test("cliDest and cliVersionFile land in the DG_HOME bin directory", () => {
		const saved = process.env.DG_HOME;
		process.env.DG_HOME = "/opt/dg-home";
		try {
			expect(cliDest("dg-agent")).toStartWith("/opt/dg-home/bin/dg-agent");
			expect(cliVersionFile("dg-agent")).toBe("/opt/dg-home/bin/.dg-agent.version");
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

	test("pickCliAsset carries the release's SHA256SUMS url only when the release publishes one", () => {
		const rel = (assets: string[]) => [{
			tag_name: "v1.0.0",
			draft: false,
			assets: assets.map((name) => ({ name, browser_download_url: `https://x/${name}` })),
		}];
		const spec = { binaryName: "dg-skills" };
		expect(pickCliAsset(rel(["dg-skills-linux-x64", "SHA256SUMS"]), spec, "linux", "x64")?.sumsUrl).toBe("https://x/SHA256SUMS");
		expect(pickCliAsset(rel(["dg-skills-linux-x64"]), spec, "linux", "x64")).not.toHaveProperty("sumsUrl");
	});
});
