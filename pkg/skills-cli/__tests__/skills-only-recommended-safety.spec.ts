import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	bareRepo,
	type FixtureSpec,
	mattpocockLikeFiles,
	removeRecommendedFixtures,
	runRecommendedSkillsOnly,
	tempDir,
} from "./recommended-fixtures";

const DG_NAMES = new Set(["grill-me", "wayfinder", "address"]);

function filesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) visit(abs);
			else out.push(relative(root, abs).split(sep).join("/"));
		}
	};
	visit(root);
	return out.sort();
}

afterEach(removeRecommendedFixtures);

function seedCanaries(dest: string): void {
	for (const name of [".system", "mine"]) {
		mkdirSync(join(dest, name), { recursive: true });
		writeFileSync(join(dest, name, "SKILL.md"), name);
	}
}

function installIntoSeeded(spec: FixtureSpec, skills?: string[]) {
	const root = tempDir("recommended-skills-seeded");
	const fixture = bareRepo(root, spec);
	const dest = join(root, "dest");
	seedCanaries(dest);
	const before = filesUnder(dest);
	const outcome = runRecommendedSkillsOnly(
		{ name: "fixture", repo: "owner/fixture", sha: fixture.sha, skills },
		dest,
		[...DG_NAMES],
		{ repo: "owner/fixture", url: fixture.url },
	);
	return { dest, before, outcome };
}

describe("installRecommendedSkillsOnly destination safety", () => {
	test("a declared path with no tracked files leaves existing dest entries alone", () => {
		const { dest, before, outcome } = installIntoSeeded(mattpocockLikeFiles(["tdd"]), [
			"./skills/tdd",
			"./skills/.system",
			"./skills/mine",
		]);
		expect(outcome.thrown).toBeUndefined();
		expect(existsSync(join(dest, ".system", "SKILL.md"))).toBe(true);
		expect(existsSync(join(dest, "mine", "SKILL.md"))).toBe(true);
		expect(filesUnder(dest).filter((file) => before.includes(file))).toEqual(before);
	});

	test("a declared skill directory that is itself a symlink aborts the plugin and copies nothing", () => {
		const spec: FixtureSpec = {
			...mattpocockLikeFiles(["tdd"]),
			links: { "skills/linked": "/etc" },
		};
		const { dest, before, outcome } = installIntoSeeded(spec, ["./skills/tdd", "./skills/linked"]);
		expect(outcome.thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual(before);
		expect(outcome.lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
	});

	test("a gitlink in a later skill leaves the whole destination unchanged", () => {
		const spec: FixtureSpec = {
			...mattpocockLikeFiles(["tdd", "later"]),
			gitlinks: { "skills/later/vendored": "1".repeat(40) },
		};
		const { dest, before, outcome } = installIntoSeeded(spec);
		expect(outcome.thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual(before);
		expect(outcome.lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
	});

	test("every warning is exactly one line", () => {
		const spec: FixtureSpec = {
			...mattpocockLikeFiles(["tdd"]),
			links: { "skills/tdd/evil.md": "/etc/passwd" },
		};
		const symlink = installIntoSeeded(spec).outcome.lines;
		const missing = installIntoSeeded(mattpocockLikeFiles(["tdd"])).outcome.lines;
		const unreachable = runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha: "2".repeat(40) },
			join(tempDir("recommended-one-line"), "dest"),
			[...DG_NAMES],
			{ repo: "owner/fixture", url: "file:///nonexistent/dg-missing.git" },
		).lines;
		const warnings = [...symlink, ...missing, ...unreachable].filter((line) => line.startsWith("⚠"));
		expect(warnings.length).toBeGreaterThanOrEqual(2);
		for (const line of warnings) expect(line.split("\n")).toHaveLength(1);
	});
});
