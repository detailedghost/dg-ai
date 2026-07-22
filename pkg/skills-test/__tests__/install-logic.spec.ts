/**
 * Unit smoke tests for the install script's release-asset resolution — the
 * exact logic that broke install (skills-v* vs ext-v* tags) and the platform→
 * binary mapping the release matrix and bootstrap scripts must agree on.
 */
import { describe, expect, test } from "bun:test";
import {
	cliAssetName,
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
			expect(cliAssetName(platform, arch)).toBe(expected);
		});
	}

	test("unsupported OS/arch → undefined", () => {
		expect(cliAssetName("aix", "x64")).toBeUndefined();
		expect(cliAssetName("linux", "mips")).toBeUndefined();
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
		const a = pickCliAsset(RELEASES, "linux", "x64");
		expect(a?.name).toBe("dg-skills-linux-x64");
		expect(a?.version).toBe("1.0.0");
	});

	test("platform with no matching asset in the release → undefined", () => {
		// linux/arm64 isn't in the fixture's asset list
		expect(pickCliAsset(RELEASES, "linux", "arm64")).toBeUndefined();
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
		expect(pickCliAsset(withDraft, "linux", "x64")?.version).toBe("1.0.0");
	});
});
