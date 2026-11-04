import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	bareRepo,
	type FixtureSpec,
	mattpocockLikeFiles,
	removeRecommendedFixtures,
	runRecommendedSkillsOnly,
	skillMarkdown,
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

	test("a plugin.json that is a symlink aborts the plugin and copies nothing", () => {
		const target = join(tempDir("recommended-manifest-target"), "plugin.json");
		writeFileSync(target, JSON.stringify({ skills: ["./skills/tdd"] }));
		const spec: FixtureSpec = {
			...mattpocockLikeFiles(["tdd"]),
			manifestSkills: undefined,
			links: { ".claude-plugin/plugin.json": target },
		};
		const { dest, before, outcome } = installIntoSeeded(spec);
		expect(outcome.thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual(before);
		const warnings = outcome.lines.filter((line) => line.startsWith("⚠ fixture skipped"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("plugin.json");
	});

	test("two skills with the same name abort the plugin before any write", () => {
		const spec: FixtureSpec = {
			files: {
				"skills/tdd/SKILL.md": skillMarkdown("tdd"),
				"other/tdd/SKILL.md": skillMarkdown("tdd"),
				"skills/solo/SKILL.md": skillMarkdown("solo"),
			},
			manifestSkills: ["./skills/solo", "./skills/tdd", "./other/tdd"],
		};
		const { dest, before, outcome } = installIntoSeeded(spec);
		expect(filesUnder(dest)).toEqual(before);
		expect(outcome.lines.filter((line) => line.startsWith("⚠"))).toEqual([
			"⚠ fixture skipped: duplicate skill name tdd",
		]);
	});

	test("a skill folder dg did not install is left alone while the rest install", () => {
		const root = tempDir("recommended-private-copy");
		const fixture = bareRepo(root, mattpocockLikeFiles(["teach", "tdd"]));
		const dest = join(root, "dest");
		mkdirSync(join(dest, "teach"), { recursive: true });
		writeFileSync(join(dest, "teach", "SKILL.md"), "private");
		const outcome = runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha: fixture.sha },
			dest,
			[...DG_NAMES],
			{ repo: "owner/fixture", url: fixture.url },
		);
		expect(readFileSync(join(dest, "teach", "SKILL.md"), "utf8")).toBe("private");
		expect(existsSync(join(dest, "teach", ".dg-recommended"))).toBe(false);
		expect(outcome.lines).toContain("skipped teach (a copy dg did not install is already there)");
		expect(existsSync(join(dest, "tdd", "SKILL.md"))).toBe(true);
		expect(outcome.written).not.toContain("teach/SKILL.md");
	});

	test("every installed skill folder carries a marker naming the plugin, and a marked folder is replaced", () => {
		const root = tempDir("recommended-marker");
		const fixture = bareRepo(root, mattpocockLikeFiles(["tdd"]));
		const dest = join(root, "dest");
		const plugin = { name: "fixture", repo: "owner/fixture", sha: fixture.sha };
		const redirect = { repo: "owner/fixture", url: fixture.url };
		const first = runRecommendedSkillsOnly(plugin, dest, [...DG_NAMES], redirect);
		expect(readFileSync(join(dest, "tdd", ".dg-recommended"), "utf8")).toBe("fixture\n");
		expect(first.written).toContain("tdd/.dg-recommended");
		writeFileSync(join(dest, "tdd", "stale.md"), "old");
		const second = runRecommendedSkillsOnly(plugin, dest, [...DG_NAMES], redirect);
		expect(second.lines.filter((line) => line.startsWith("skipped"))).toEqual([]);
		expect(existsSync(join(dest, "tdd", "stale.md"))).toBe(false);
	});
});
