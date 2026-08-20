/**
 * Unit smoke tests for the install script's release-asset resolution — the
 * exact logic that broke install (skills-v* vs ext-v* tags) and the platform→
 * binary mapping the release matrix and bootstrap scripts must agree on.
 */
import { describe, expect, test } from "bun:test";
import {
	cliAssetName,
	cliDest,
	cliVersionFile,
	pickCliAsset,
	pickExtAsset,
	type Release,
} from "@dg/skills-cli/lib";

const RELEASES: Release[] = [
	{
		tag_name: "skills-v1.0.0",
		draft: false,
		assets: [
			{ name: "dg-skills-linux-x64", browser_download_url: "u/linux-x64" },
			{ name: "dg-skills-macos-arm64", browser_download_url: "u/macos-arm64" },
			{
				name: "dg-skills-windows-x64.exe",
				browser_download_url: "u/win-x64",
			},
		],
	},
	{
		tag_name: "ext-v1.7.6",
		draft: false,
		assets: [
			{
				name: "dg-ai-extension-1.7.6-chrome.zip",
				browser_download_url: "u/chrome",
			},
			{
				name: "dg-ai-extension-1.7.6-firefox.zip",
				browser_download_url: "u/firefox",
			},
		],
	},
	{
		tag_name: "server-v1.0.0",
		draft: false,
		assets: [
			{ name: "dg-server-linux-x64", browser_download_url: "u/srv-linux-x64" },
			{
				name: "dg-server-windows-x64.exe",
				browser_download_url: "u/srv-win-x64",
			},
		],
	},
	// legacy pre-split tag — must be ignored by both selectors
	{ tag_name: "v1.2.0", draft: false, assets: [] },
];

describe("cliAssetName", () => {
	const cases: [string, string, string][] = [
		["linux", "x64", "dg-skills-linux-x64"],
		["linux", "arm64", "dg-skills-linux-arm64"],
		["darwin", "x64", "dg-skills-macos-x64"],
		["darwin", "arm64", "dg-skills-macos-arm64"],
		["win32", "x64", "dg-skills-windows-x64.exe"],
		["win32", "arm64", "dg-skills-windows-arm64.exe"],
	];
	for (const [platform, arch, expected] of cases) {
		test(`${platform}/${arch} → ${expected}`, () => {
			expect(cliAssetName("dg-skills", platform, arch)).toBe(expected);
		});
	}

	test("unsupported OS/arch → undefined", () => {
		expect(cliAssetName("dg-skills", "aix", "x64")).toBeUndefined();
		expect(cliAssetName("dg-skills", "linux", "mips")).toBeUndefined();
	});
});

describe("pickExtAsset (extension zip from ext-v* only)", () => {
	test("chrome resolves the ext-v* zip, not a skills-v* release", () => {
		const a = pickExtAsset(RELEASES, "chrome");
		expect(a?.name).toBe("dg-ai-extension-1.7.6-chrome.zip");
		expect(a?.version).toBe("1.7.6");
	});

	test("firefox resolves its zip", () => {
		expect(pickExtAsset(RELEASES, "firefox")?.name).toContain("firefox");
	});

	test("no ext-v* release → undefined", () => {
		expect(pickExtAsset([RELEASES[0]], "chrome")).toBeUndefined();
	});
});

describe("pickCliAsset (binary from skills-v* only)", () => {
	test("linux/x64 resolves the skills-v* binary, not ext-v*", () => {
		const a = pickCliAsset(RELEASES, "dg-skills", "skills-v", "linux", "x64");
		expect(a?.name).toBe("dg-skills-linux-x64");
		expect(a?.version).toBe("1.0.0");
	});

	test("platform with no matching asset in the release → undefined", () => {
		// linux/arm64 isn't in the fixture's asset list
		expect(
			pickCliAsset(RELEASES, "dg-skills", "skills-v", "linux", "arm64"),
		).toBeUndefined();
	});

	test("draft releases are skipped", () => {
		const withDraft: Release[] = [
			{
				tag_name: "skills-v2.0.0",
				draft: true,
				assets: [
					{ name: "dg-skills-linux-x64", browser_download_url: "u/draft" },
				],
			},
			...RELEASES,
		];
		expect(
			pickCliAsset(withDraft, "dg-skills", "skills-v", "linux", "x64")?.version,
		).toBe("1.0.0");
	});
});

describe("the fetcher is generalized over binaryName and tagPrefix, with no derivation rule", () => {
	test("cliAssetName builds a dg-server name for every supported platform", () => {
		const cases: [string, string, string][] = [
			["linux", "x64", "dg-server-linux-x64"],
			["linux", "arm64", "dg-server-linux-arm64"],
			["darwin", "x64", "dg-server-macos-x64"],
			["darwin", "arm64", "dg-server-macos-arm64"],
			["win32", "x64", "dg-server-windows-x64.exe"],
			["win32", "arm64", "dg-server-windows-arm64.exe"],
		];
		for (const [platform, arch, expected] of cases) {
			expect(cliAssetName("dg-server", platform, arch)).toBe(expected);
		}
	});

	test("pickCliAsset resolves dg-server from server-v*, never from skills-v*", () => {
		const picked = pickCliAsset(
			RELEASES,
			"dg-server",
			"server-v",
			"linux",
			"x64",
		);
		expect(picked?.name).toBe("dg-server-linux-x64");
		expect(picked?.version).toBe("1.0.0");
		expect(picked?.url).toBe("u/srv-linux-x64");
	});

	test("the tag prefix is not derived from the binary name — a mismatched pair resolves nothing", () => {
		expect(
			pickCliAsset(RELEASES, "dg-server", "skills-v", "linux", "x64"),
		).toBeUndefined();
		expect(
			pickCliAsset(RELEASES, "dg-skills", "server-v", "linux", "x64"),
		).toBeUndefined();
	});

	test("a platform with no published dg-server asset resolves undefined rather than a skills binary", () => {
		expect(
			pickCliAsset(RELEASES, "dg-server", "server-v", "darwin", "arm64"),
		).toBeUndefined();
	});

	test("cliDest and cliVersionFile are per-binary, so one install cannot overwrite the other", () => {
		expect(cliDest("dg-skills")).not.toBe(cliDest("dg-server"));
		expect(cliDest("dg-server")).toContain("dg-server");
		expect(cliVersionFile("dg-server")).toContain(".dg-server.version");
		expect(cliVersionFile("dg-skills")).toContain(".dg-skills.version");
	});
});
