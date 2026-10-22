import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");
const CLEANUP_DIR = join(SKILLS_DIR, "cleanup");
const LS_SKILLS_PATH = join(SKILLS_DIR, "ls-skills", "SKILL.md");

function cleanupFiles(): string[] {
	return [
		join(CLEANUP_DIR, "SKILL.md"),
		join(CLEANUP_DIR, "references", "targets.md"),
		join(CLEANUP_DIR, "references", "checks.md"),
		join(CLEANUP_DIR, "references", "migrations.md"),
	];
}

function readAll(files: string[]): string {
	return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

describe("cleanup skill", () => {
	test("has cross-host frontmatter with only name and description", () => {
		const text = readFileSync(join(CLEANUP_DIR, "SKILL.md"), "utf8");
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
		const keys = front
			.split("\n")
			.filter((line) => /^[a-z-]+:/.test(line))
			.map((line) => line.split(":")[0]);
		expect(keys).toEqual(["name", "description"]);
	});

	test("configures the daily-prune executable instead of a hardcoded path and stops with an actionable error when it is unavailable", () => {
		const text = readAll(cleanupFiles());
		expect(text).toContain("DG_DAILY_PRUNE_CMD");
		expect(text).toMatch(/never guess a path/);
		expect(text).toMatch(/not found or not executable/);
	});

	test("gates maintenance writes on a source checkout and otherwise only proposes", () => {
		const text = readAll(cleanupFiles());
		expect(text).toContain("Source checkout vs. installed");
		expect(text).toMatch(/source checkout/i);
		expect(text).toMatch(/\bproposals?\b/i);
		expect(text).toContain("~/.dg/bin/dg-skills stash -s -G cleanup history.md");
	});

	test("reads the address roster via a relative link that resolves", () => {
		const skill = readFileSync(join(CLEANUP_DIR, "SKILL.md"), "utf8");
		const link = /\]\((\.\.\/address\/references\/agents\.md)\)/.exec(skill)?.[1];
		expect(link).toBeDefined();
		expect(existsSync(join(CLEANUP_DIR, link ?? ""))).toBe(true);
	});

	test("carries no machine-local paths", () => {
		for (const file of cleanupFiles()) {
			expect(readFileSync(file, "utf8")).not.toMatch(
				/\/home\/|~\/scripts|\/mnt\/c\//,
			);
		}
	});

	test("defers skill-quality restructuring to skill-cleanup by name only, not a link to an unshipped skill", () => {
		const text = readAll(cleanupFiles());
		expect(text).toContain("/dg:skill-cleanup");
		expect(text).not.toContain("](../skill-cleanup/");
	});
});

describe("ls-skills skill", () => {
	test("has cross-host frontmatter with only name and description", () => {
		const text = readFileSync(LS_SKILLS_PATH, "utf8");
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
		const keys = front
			.split("\n")
			.filter((line) => /^[a-z-]+:/.test(line))
			.map((line) => line.split(":")[0]);
		expect(keys).toEqual(["name", "description"]);
	});

	function descriptionRows(text: string): string[] {
		const start = text.indexOf("## Descriptions");
		const end = text.indexOf("## Categories");
		const section = text.slice(start, end);
		return [...section.matchAll(/^\| (dg:[a-z0-9-]+) \|/gm)].map((m) => m[1]);
	}

	function categoryMembers(text: string): string[] {
		const start = text.indexOf("## Categories");
		const end = text.indexOf("## Render rules");
		const section = text.slice(start, end);
		return [...section.matchAll(/dg:[a-z0-9-]+/g)].map((m) => m[0]);
	}

	test("every table row names a dg:-prefixed skill", () => {
		const text = readFileSync(LS_SKILLS_PATH, "utf8");
		const rows = descriptionRows(text);
		expect(rows.length).toBeGreaterThan(40);
		for (const row of rows) expect(row.startsWith("dg:")).toBe(true);
	});

	test("the descriptions table and the category members list name exactly the same skills", () => {
		const text = readFileSync(LS_SKILLS_PATH, "utf8");
		const rows = new Set(descriptionRows(text));
		const members = new Set(categoryMembers(text));
		expect([...rows].sort()).toEqual([...members].sort());
	});

	test("drops the retired and merged skills", () => {
		const text = readFileSync(LS_SKILLS_PATH, "utf8");
		for (const retired of [
			"dg:viz",
			"dg:review ",
			"dg:lineage",
			"dg:clockout",
			"dg:caveman",
			"dg:powerbi",
			"dg:prototype",
		])
			expect(text).not.toContain(retired);
	});

	test("folds the sync family into sync, claude-sync, codex-sync, copilot-sync, opencode-sync", () => {
		const text = readFileSync(LS_SKILLS_PATH, "utf8");
		for (const name of [
			"dg:sync",
			"dg:claude-sync",
			"dg:codex-sync",
			"dg:copilot-sync",
			"dg:opencode-sync",
		])
			expect(text).toContain(name);
	});
});
