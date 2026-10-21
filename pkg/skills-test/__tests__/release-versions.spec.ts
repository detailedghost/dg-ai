import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { currentTag, pinnedFiles } from "../../../scripts/pin-bootstrap-tag";
import { readRepoFile } from "./test-support";

const LAST_RELEASED = "1.15.0";

function parts(version: string): number[] {
	return version.split(".").map(Number);
}

function isNewer(version: string, base: string): boolean {
	const [a, b] = [parts(version), parts(base)];
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

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
		expect(isNewer(reported ?? "0.0.0", LAST_RELEASED)).toBe(true);
	});

	test("every released package and both manifests move past the last released version together", () => {
		const all = [
			...RELEASED_PACKAGES.map(packageVersion),
			...manifestVersions(),
		];

		expect(new Set(all).size).toBe(1);
		expect(isNewer(all[0], LAST_RELEASED)).toBe(true);
	});

	test("every bootstrap URL points at the tag of the shared version", () => {
		const tag = currentTag();
		const urls = pinnedFiles().flatMap((file) => {
			const text = readFileSync(file, "utf8");
			return [
				...text.matchAll(
					/raw\.githubusercontent\.com\/detailedghost\/dg-ai\/([^/]+)\/pkg\/skills-cli\/bootstrap\.(?:sh|ps1)/g,
				),
			].map((m) => m[1]);
		});

		expect(tag).toBe(`skills-v${packageVersion("skills-cli")}`);
		expect(urls.length).toBeGreaterThan(0);
		expect(new Set(urls)).toEqual(new Set([tag]));
	});

	test("the README names the shared version", () => {
		const readme = readRepoFile("README.md");
		const named = /version \*\*(\d+\.\d+\.\d+)\*\*/.exec(readme)?.[1];

		expect(named).toBe(packageVersion("skills-cli"));
	});
});
