import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

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
		const versions = RELEASED_PACKAGES.map((pkg) => [
			pkg,
			packageVersion(pkg),
		]);
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
});
