import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const RELEASE_WORKFLOWS = [
	"ext-release.yml",
	"skills-release.yml",
	"dg-daemon-release.yml",
	"dg-agent-release.yml",
] as const;

const RELEASED = [
	{ pkg: "extension", release: "ext-release.yml", blt: "ext-blt.yml" },
	{ pkg: "skills-cli", release: "skills-release.yml", blt: "skills-blt.yml" },
	{
		pkg: "dg-daemon",
		release: "dg-daemon-release.yml",
		blt: "dg-daemon-blt.yml",
	},
	{ pkg: "dg-agent", release: "dg-agent-release.yml", blt: "dg-agent-blt.yml" },
] as const;

function workflow(name: string): string {
	return readRepoFile(".github", "workflows", name);
}

function watchedPackages(name: string): string[] {
	const block = /paths:\n((?: {6}- \S+\n)+)/.exec(workflow(name))?.[1] ?? "";
	return [...block.matchAll(/- pkg\/(\S+?)\/\*\*/g)].map((m) => m[1]);
}

function workspaceDeps(pkg: string, field: string): string[] {
	const json = JSON.parse(readRepoFile("pkg", pkg, "package.json"));
	return Object.entries(json[field] ?? {})
		.filter(([, range]) => String(range).startsWith("workspace:"))
		.map(([name]) => name.replace("@dg/", ""));
}

describe("a release fires for exactly the source its artifact is built from", () => {
	for (const { pkg, release } of RELEASED) {
		test(`${release} watches ${pkg} and every package it ships`, () => {
			const watched = watchedPackages(release);

			expect(watched).toContain(pkg);
			for (const dep of workspaceDeps(pkg, "dependencies")) {
				expect(watched).toContain(dep);
			}
		});
	}

	test("no release fires for a package its binary does not contain", () => {
		for (const { pkg, release } of RELEASED) {
			const shipped = new Set([pkg, ...workspaceDeps(pkg, "dependencies")]);

			for (const watched of watchedPackages(release)) {
				expect(shipped).toContain(watched);
			}
		}
	});

	test("a build watches its test-only dependencies too, which a release must not", () => {
		const devDeps = workspaceDeps("dg-agent", "devDependencies");

		expect(devDeps).toEqual(["dg-daemon"]);
		expect(watchedPackages("dg-agent-blt.yml")).toContain("dg-daemon");
		expect(watchedPackages("dg-agent-release.yml")).not.toContain("dg-daemon");
	});
});

describe("one dispatch cuts the whole matched set", () => {
	const all = workflow("release-all.yml");

	test("release-all calls every release workflow, and only those", () => {
		const called = [
			...all.matchAll(/uses: \.\/\.github\/workflows\/(\S+)/g),
		].map((m) => m[1]);

		expect(called.sort()).toEqual([...RELEASE_WORKFLOWS].sort());
	});

	test("every release workflow accepts being called, or release-all cannot run it", () => {
		for (const name of RELEASE_WORKFLOWS) {
			expect(workflow(name)).toContain("workflow_call:");
		}
	});

	test("release-all is dispatch-only, so it never doubles a push-triggered release", () => {
		expect(all).toContain("workflow_dispatch:");
		expect(all).not.toContain("push:");
	});
});
