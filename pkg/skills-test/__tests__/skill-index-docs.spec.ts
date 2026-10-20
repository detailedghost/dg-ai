import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const WAVE_3_SKILLS = [
	"worktree",
	"spec",
	"sdlc",
	"assign",
	"monolith",
	"spring-break",
	"polish",
] as const;

function indexesSkill(doc: string, skill: string): boolean {
	return doc.includes(`\`${skill}\``) || doc.includes(`\`${skill}/\``);
}

describe("skill indexes list every Wave 3 skill", () => {
	for (const [label, parts] of [
		["README.md", ["README.md"]],
		["docs/install.md", ["docs", "install.md"]],
		["plugins/dg/skills/README.md", ["plugins", "dg", "skills", "README.md"]],
	] as const) {
		test(`${label} names each Wave 3 skill`, () => {
			const doc = readRepoFile(...parts);
			const missing = WAVE_3_SKILLS.filter((s) => !indexesSkill(doc, s));
			expect(missing).toEqual([]);
		});
	}

	test("viz and review are not packaged or indexed", () => {
		for (const skill of ["viz", "review"]) {
			expect(
				existsSync(join(REPO_ROOT, "plugins", "dg", "skills", skill)),
			).toBe(false);
			for (const parts of [
				["README.md"],
				["docs", "install.md"],
				["plugins", "dg", "skills", "README.md"],
			]) {
				expect(indexesSkill(readRepoFile(...parts), skill)).toBe(false);
			}
		}
	});

	test("every indexed Wave 3 skill ships a SKILL.md", () => {
		for (const skill of WAVE_3_SKILLS) {
			expect(
				existsSync(join(REPO_ROOT, "plugins", "dg", "skills", skill, "SKILL.md")),
			).toBe(true);
		}
	});
});
