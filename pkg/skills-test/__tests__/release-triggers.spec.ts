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

/** Job id → the jobs it lists under `needs`. Walks only the `jobs:` block. */
function jobNeeds(text: string): Map<string, string[]> {
	const needs = new Map<string, string[]>();
	let inJobs = false;
	let current: string | null = null;
	let readingNeeds = false;

	for (const line of text.split("\n")) {
		if (line === "jobs:") {
			inJobs = true;
			continue;
		}
		if (!inJobs) continue;

		const job = /^  ([a-z0-9-]+):\s*$/.exec(line);
		if (job) {
			current = job[1];
			needs.set(current, []);
			readingNeeds = false;
			continue;
		}
		if (!current) continue;

		if (/^    needs:\s*$/.test(line)) {
			readingNeeds = true;
			continue;
		}

		const inline = /^    needs:\s*(.+)$/.exec(line);
		if (inline) {
			const value = inline[1].trim();
			const listed = value.startsWith("[")
				? value
						.slice(1, value.endsWith("]") ? -1 : undefined)
						.split(",")
						.map((name) => name.trim())
						.filter(Boolean)
				: [value];
			needs.get(current)!.push(...listed);
			readingNeeds = value.startsWith("[") && !value.endsWith("]");
			continue;
		}

		const item = /^      - (\S+)\s*$/.exec(line);
		if (readingNeeds && item) {
			needs.get(current)!.push(item[1]);
			continue;
		}
		readingNeeds = false;
	}

	return needs;
}

function reaches(
	needs: Map<string, string[]>,
	from: string,
	target: string,
): boolean {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const job = stack.pop()!;
		if (job === target) return true;
		if (seen.has(job)) continue;
		seen.add(job);
		for (const dep of needs.get(job) ?? []) stack.push(dep);
	}
	return false;
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
		for (const { pkg, release, blt } of RELEASED) {
			for (const dep of workspaceDeps(pkg, "devDependencies")) {
				expect(watchedPackages(blt)).toContain(dep);
				expect(watchedPackages(release)).not.toContain(dep);
			}
		}
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

describe("a release publishes only after its own build workflow passes", () => {
	for (const { release, blt } of RELEASED) {
		test(`${release} calls ${blt} and the publish job waits on that call`, () => {
			const text = workflow(release);
			const needs = jobNeeds(text);
			const bltJob = [...needs.keys()].find((job) =>
				new RegExp(
					`^  ${job}:\\n    uses: \\./\\.github/workflows/${blt}\\s*$`,
					"m",
				).test(text),
			);

			expect(bltJob).toBe("blt");
			expect(reaches(needs, "release", "blt")).toBe(true);
		});
	}
});
