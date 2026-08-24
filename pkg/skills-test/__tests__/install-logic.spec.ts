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
import { SUPPORTED_PLATFORMS } from "./supported-platforms";

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
		tag_name: "daemon-v1.0.0",
		draft: false,
		assets: [
			{ name: "dg-daemon-linux-x64", browser_download_url: "u/srv-linux-x64" },
			{
				name: "dg-daemon-windows-x64.exe",
				browser_download_url: "u/srv-win-x64",
			},
		],
	},
	// legacy pre-split tag — must be ignored by both selectors
	{ tag_name: "v1.2.0", draft: false, assets: [] },
];

const SKILLS_SPEC = { binaryName: "dg-skills", tagPrefix: "skills-v" };
const DAEMON_SPEC = { binaryName: "dg-daemon", tagPrefix: "daemon-v" };

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
		const a = pickCliAsset(RELEASES, SKILLS_SPEC, "linux", "x64");
		expect(a?.name).toBe("dg-skills-linux-x64");
		expect(a?.version).toBe("1.0.0");
	});

	test("platform with no matching asset in the release → undefined", () => {
		// linux/arm64 isn't in the fixture's asset list
		expect(
			pickCliAsset(RELEASES, SKILLS_SPEC, "linux", "arm64"),
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
		expect(pickCliAsset(withDraft, SKILLS_SPEC, "linux", "x64")?.version).toBe(
			"1.0.0",
		);
	});
});

describe("the fetcher is generalized over binaryName and tagPrefix, with no derivation rule", () => {
	test("cliAssetName builds a dg-daemon name for every supported platform", () => {
		for (const { platform, arch, assetName } of SUPPORTED_PLATFORMS) {
			expect(cliAssetName("dg-daemon", platform, arch)).toBe(
				assetName["dg-daemon"],
			);
		}
	});

	test("pickCliAsset resolves dg-daemon from daemon-v*, never from skills-v*", () => {
		const picked = pickCliAsset(RELEASES, DAEMON_SPEC, "linux", "x64");
		expect(picked?.name).toBe("dg-daemon-linux-x64");
		expect(picked?.version).toBe("1.0.0");
		expect(picked?.url).toBe("u/srv-linux-x64");
	});

	test("the tag prefix is not derived from the binary name — a mismatched pair resolves nothing", () => {
		expect(
			pickCliAsset(
				RELEASES,
				{ binaryName: "dg-daemon", tagPrefix: "skills-v" },
				"linux",
				"x64",
			),
		).toBeUndefined();
		expect(
			pickCliAsset(
				RELEASES,
				{ binaryName: "dg-skills", tagPrefix: "daemon-v" },
				"linux",
				"x64",
			),
		).toBeUndefined();
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
});
