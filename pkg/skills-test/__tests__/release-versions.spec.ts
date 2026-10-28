import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

function manifestVersions(): string[] {
	return [
		JSON.parse(readRepoFile(".claude-plugin", "plugin.json")).version,
		JSON.parse(readRepoFile("plugins", "dg", ".codex-plugin", "plugin.json"))
			.version,
	];
}

const RELEASED_PACKAGES = [
	"extension",
	"skills-cli",
	"dg-daemon",
	"dg-agent",
] as const;

function packageVersion(pkg: string): string {
	return JSON.parse(readRepoFile("pkg", pkg, "package.json")).version;
}

describe("the released packages ship as one matched set", () => {
	test("every package with a release workflow carries the same version", () => {
		const versions = RELEASED_PACKAGES.map((pkg) => [pkg, packageVersion(pkg)]);
		const distinct = new Set(versions.map(([, v]) => v));

		expect(versions.length).toBe(RELEASED_PACKAGES.length);
		expect([...distinct]).toEqual([versions[0][1]]);
	});

	test("each release workflow tags from its own package.json, so one bump moves them together", () => {
		for (const [pkg, workflow] of [
			["extension", "ext-release.yml"],
			["skills-cli", "skills-release.yml"],
			["dg-daemon", "dg-daemon-release.yml"],
			["dg-agent", "dg-agent-release.yml"],
		]) {
			const rel = readRepoFile(".github", "workflows", workflow);
			expect(rel).toMatch(
				new RegExp(`require\\('\\./(pkg/${pkg}/)?package\\.json'\\)\\.version`),
			);
		}
	});

	test("the version dg-agent reports is the version it was packaged as", () => {
		const version = readRepoFile("pkg", "dg-agent", "src", "version.ts");
		const reported = /DG_AGENT_PACKAGE_VERSION = "([^"]+)"/.exec(version)?.[1];

		expect(reported).toBe(packageVersion("dg-agent"));
	});

	test("the version the daemon reports is the version it was packaged as", () => {
		const status = readRepoFile(
			"pkg",
			"dg-daemon",
			"src",
			"server",
			"status.ts",
		);
		const reported = /DG_DAEMON_PACKAGE_VERSION = "([^"]+)"/.exec(status)?.[1];

		expect(reported).toBe(packageVersion("dg-daemon"));
	});

	test("every released package and both manifests share one version", () => {
		const all = [
			...RELEASED_PACKAGES.map(packageVersion),
			...manifestVersions(),
		];

		expect(new Set(all).size).toBe(1);
	});
});
