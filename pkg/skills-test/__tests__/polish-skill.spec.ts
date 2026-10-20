import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const POLISH_DIR = join(REPO_ROOT, "plugins", "dg", "skills", "polish");

function markdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return markdownFiles(path);
		return entry.endsWith(".md") ? [path] : [];
	});
}

describe("polish skill ships publicly", () => {
	test("has a SKILL.md with polish front matter", () => {
		const skill = join(POLISH_DIR, "SKILL.md");
		expect(existsSync(skill)).toBe(true);
		expect(readFileSync(skill, "utf8")).toMatch(/^---\nname: polish\n/);
	});

	test("carries no machine-local paths", () => {
		const files = markdownFiles(POLISH_DIR);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			expect(readFileSync(file, "utf8")).not.toMatch(
				/\/home\/|~\/\.claude|~\/scripts|\/mnt\/c\//,
			);
		}
	});

	test("links the one shared pr-body style guide relatively instead of keeping a copy", () => {
		expect(existsSync(join(POLISH_DIR, "references", "pr-body-style.md"))).toBe(
			false,
		);
		const skill = readFileSync(join(POLISH_DIR, "SKILL.md"), "utf8");
		const link = /\]\((\.\.\/[^)]*pr-body-style\.md)\)/.exec(skill)?.[1];
		expect(link).toBeDefined();
		expect(existsSync(join(POLISH_DIR, link ?? ""))).toBe(true);
	});

	test("runs the prose check through a configurable external command", () => {
		const text = markdownFiles(POLISH_DIR)
			.map((f) => readFileSync(f, "utf8"))
			.join("\n");
		expect(text).toMatch(/DG_[A-Z_]*PROSE[A-Z_]*|prose[- ]check/i);
		expect(text).toMatch(/configur|environment variable|\$\{?DG_/i);
	});
});
