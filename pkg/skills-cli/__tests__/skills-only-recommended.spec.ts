import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { join, relative, sep } from "node:path";
import { git } from "./git-repo-fixtures";
import {
	bareRepo,
	type FixtureSpec,
	mattpocockLikeFiles,
	runRecommendedSkillsOnly,
	removeRecommendedFixtures,
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

function install(spec: FixtureSpec, pinOverride?: string, skills?: string[], extraEnv: Record<string, string> = {}) {
	const root = tempDir("recommended-skills");
	const fixture = bareRepo(root, spec);
	const dest = join(root, "dest");
	const outcome = runRecommendedSkillsOnly(
		{ name: "fixture", repo: "owner/fixture", sha: pinOverride ?? fixture.sha, skills },
		dest,
		[...DG_NAMES],
		{ repo: "owner/fixture", url: fixture.url },
		extraEnv,
	);
	return { dest, lines: outcome.lines, written: outcome.written, thrown: outcome.thrown, root, fixture };
}

afterEach(removeRecommendedFixtures);

describe("installRecommendedSkillsOnly", () => {
	test("copies every declared skill directory into dest/<skill-name>", () => {
		const { dest, lines, thrown } = install(mattpocockLikeFiles(["tdd", "teach"]));
		expect(thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual([
			"tdd/SKILL.md",
			"tdd/references/notes.md",
			"teach/SKILL.md",
			"teach/references/notes.md",
		]);
		expect(lines.filter((line) => line.startsWith("skipped"))).toEqual([]);
	});

	test("skips a skill that collides with a dg skill and prints one skipped line each", () => {
		const { dest, lines, thrown } = install(mattpocockLikeFiles(["tdd", "grill-me", "wayfinder"]));
		expect(thrown).toBeUndefined();
		expect(existsSync(join(dest, "grill-me"))).toBe(false);
		expect(existsSync(join(dest, "wayfinder"))).toBe(false);
		expect(existsSync(join(dest, "tdd", "SKILL.md"))).toBe(true);
		expect(lines.filter((line) => line === "skipped grill-me (dg ships its own)")).toHaveLength(1);
		expect(lines.filter((line) => line === "skipped wayfinder (dg ships its own)")).toHaveLength(1);
		expect(lines.filter((line) => line.startsWith("skipped"))).toHaveLength(2);
	});

	test("returns the relative paths it wrote", () => {
		const { dest, written } = install(mattpocockLikeFiles(["tdd", "grill-me"]));
		expect([...written].map((path) => path.split(sep).join("/")).sort()).toEqual(filesUnder(dest));
	});

	test("replaces an existing skill directory and leaves other entries in dest", () => {
		const root = tempDir("recommended-skills-replace");
		const fixture = bareRepo(root, mattpocockLikeFiles(["tdd"]));
		const dest = join(root, "dest");
		mkdirSync(join(dest, "tdd"), { recursive: true });
		mkdirSync(join(dest, "keep"), { recursive: true });
		writeFileSync(join(dest, "tdd", "stale.md"), "old");
		writeFileSync(join(dest, "keep", "SKILL.md"), "keep");
		runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha: fixture.sha },
			dest,
			[...DG_NAMES],
			{ repo: "owner/fixture", url: fixture.url },
		);
		expect(existsSync(join(dest, "tdd", "stale.md"))).toBe(false);
		expect(existsSync(join(dest, "tdd", "SKILL.md"))).toBe(true);
		expect(existsSync(join(dest, "keep", "SKILL.md"))).toBe(true);
	});

	test("an entry skills key of ./ installs the repository root as the plugin-named skill, without .git", () => {
		const spec: FixtureSpec = {
			files: { "SKILL.md": skillMarkdown("fixture"), "references/guide.md": "guide\n" },
		};
		const { dest, thrown } = install(spec, undefined, ["./"]);
		expect(thrown).toBeUndefined();
		const files = filesUnder(dest);
		expect(files).toContain("fixture/SKILL.md");
		expect(files).toContain("fixture/references/guide.md");
		expect(files.filter((file) => file.includes(".git"))).toEqual([]);
	});

	test("the entry skills key wins over the repository plugin.json", () => {
		const spec = mattpocockLikeFiles(["tdd", "other"]);
		const { dest, thrown } = install(spec, undefined, ["./skills/other"]);
		expect(thrown).toBeUndefined();
		expect(filesUnder(dest).every((file) => file.startsWith("other/"))).toBe(true);
		expect(filesUnder(dest).length).toBeGreaterThan(0);
	});

	test("a checkout whose HEAD is not the pinned sha aborts the plugin and copies nothing", () => {
		const root = tempDir("recommended-skills-mismatch");
		const bin = join(root, "fakegit");
		const realGit = Bun.which("git") as string;
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\ncase "$*" in\n*"rev-parse HEAD"*) echo ${"f".repeat(40)} ;;\n*) exec "${realGit}" "$@" ;;\nesac\n`,
			{ mode: 0o755 },
		);
		const { dest, lines, thrown } = install(mattpocockLikeFiles(["tdd"]), undefined, undefined, {
			PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
		});
		expect(thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual([]);
		expect(lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
	});

	test("a pinned sha the repository does not hold warns once and copies nothing", () => {
		const { dest, lines, thrown } = install(mattpocockLikeFiles(["tdd"]), "0".repeat(40));
		expect(thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual([]);
		expect(lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
	});

	test("a symlink inside a declared skill directory aborts the plugin and copies nothing", () => {
		const spec: FixtureSpec = {
			...mattpocockLikeFiles(["tdd", "linked"]),
			links: { "skills/linked/evil.md": "/etc/passwd" },
		};
		const { dest, lines, thrown } = install(spec);
		expect(thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual([]);
		expect(existsSync(join(dest, "tdd"))).toBe(false);
		expect(lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
	});

	test("a declared path that matches no skill directory deletes nothing in dest", () => {
		const root = tempDir("recommended-skills-hostile");
		const fixture = bareRepo(root, {
			...mattpocockLikeFiles(["tdd"]),
			manifestSkills: ["./skills/tdd", "./.system", "./README.md", "./mine"],
		});
		const dest = join(root, "dest");
		for (const name of [".system", "mine"]) {
			mkdirSync(join(dest, name), { recursive: true });
			writeFileSync(join(dest, name, "SKILL.md"), "keep");
		}
		writeFileSync(join(dest, "README.md"), "keep");
		const outcome = runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha: fixture.sha },
			dest,
			[...DG_NAMES],
			{ repo: "owner/fixture", url: fixture.url },
		);
		expect(outcome.lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
		expect(filesUnder(dest)).toEqual([".system/SKILL.md", "README.md", "mine/SKILL.md"]);
	});

	test("a declared directory that is itself a symlink aborts and keeps the existing copy", () => {
		const root = tempDir("recommended-skills-dirlink");
		const fixture = bareRepo(root, {
			...mattpocockLikeFiles(["other"]),
			links: { "skills/tdd": "/etc" },
			manifestSkills: ["./skills/other", "./skills/tdd"],
		});
		const dest = join(root, "dest");
		mkdirSync(join(dest, "tdd"), { recursive: true });
		writeFileSync(join(dest, "tdd", "SKILL.md"), "keep");
		const outcome = runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha: fixture.sha },
			dest,
			[...DG_NAMES],
			{ repo: "owner/fixture", url: fixture.url },
		);
		expect(outcome.lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
		expect(filesUnder(dest)).toEqual(["tdd/SKILL.md"]);
	});

	test("a declared directory without SKILL.md or with an unsafe name aborts the plugin", () => {
		for (const [files, manifest] of [
			[{ "docs/guide.md": "x" }, ["./docs"]],
			[{ "skills/Grill-Me/SKILL.md": skillMarkdown("x") }, ["./skills/Grill-Me"]],
		] as const) {
			const { dest, lines } = install({ files: { ...files }, manifestSkills: [...manifest] });
			expect(filesUnder(dest)).toEqual([]);
			expect(lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
		}
	});

	test("a gitlink inside a declared skill aborts the plugin before dest changes", () => {
		const root = tempDir("recommended-skills-gitlink");
		const spec = mattpocockLikeFiles(["aaa", "zzz"]);
		const fixture = bareRepo(root, spec);
		const work = join(root, "work");
		git(["update-index", "--add", "--cacheinfo", `160000,${fixture.sha},skills/zzz/sub`], work);
		git(["commit", "-q", "-m", "gitlink"], work);
		const sha = git(["rev-parse", "HEAD"], work).trim();
		git(["push", "-q", fixture.bare, `HEAD:refs/heads/main`], work);
		const dest = join(root, "dest");
		mkdirSync(join(dest, "zzz"), { recursive: true });
		writeFileSync(join(dest, "zzz", "SKILL.md"), "keep");
		const outcome = runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha },
			dest,
			[...DG_NAMES],
			{ repo: "owner/fixture", url: fixture.url },
		);
		expect(outcome.lines.filter((line) => line.startsWith("⚠ fixture skipped"))).toHaveLength(1);
		expect(filesUnder(dest)).toEqual(["zzz/SKILL.md"]);
	});

	test("the repository root skill copies its tracked files except dot paths", () => {
		const { dest } = install(
			{
				files: {
					"SKILL.md": skillMarkdown("fixture"),
					"references/guide.md": "guide\n",
					"scripts/extract.py": "print(1)\n",
					"README.md": "readme\n",
					".github/workflows/ci.yml": "on: push\n",
					".claude-plugin/plugin.json": "{}\n",
				},
			},
			undefined,
			["./"],
		);
		expect(filesUnder(dest)).toEqual([
			"fixture/README.md",
			"fixture/SKILL.md",
			"fixture/references/guide.md",
			"fixture/scripts/extract.py",
		]);
	});

	test("an unreachable repository warns once and copies nothing", () => {
		const root = tempDir("recommended-skills-offline");
		const dest = join(root, "dest");
		const outcome = runRecommendedSkillsOnly(
			{ name: "fixture", repo: "owner/fixture", sha: "1".repeat(40) },
			dest,
			[...DG_NAMES],
			{ repo: "owner/fixture", url: `file://${join(root, "missing.git")}` },
		);
		expect(outcome.thrown).toBeUndefined();
		expect(filesUnder(dest)).toEqual([]);
		expect(outcome.lines).toHaveLength(1);
		expect(outcome.lines[0]).toMatch(/^⚠ fixture skipped: /);
		expect(outcome.lines[0]).not.toContain("\n");
	});
});
