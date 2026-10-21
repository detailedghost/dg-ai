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

const WAVE_4_SKILLS = [
	"jot",
	"bg",
	"cls",
	"stat",
	"sniff",
	"nope",
	"find-work",
	"doctor",
] as const;

const INDEXES = [
	["README.md", ["README.md"]],
	["docs/install.md", ["docs", "install.md"]],
	["plugins/dg/skills/README.md", ["plugins", "dg", "skills", "README.md"]],
] as const;

function indexTests(wave: string, skills: readonly string[]): void {
	for (const [label, parts] of INDEXES) {
		test(`${label} names each ${wave} skill`, () => {
			const doc = readRepoFile(...parts);
			const missing = skills.filter((s) => !indexesSkill(doc, s));
			expect(missing).toEqual([]);
		});
	}

	test(`every indexed ${wave} skill ships a SKILL.md`, () => {
		for (const skill of skills) {
			expect(
				existsSync(join(REPO_ROOT, "plugins", "dg", "skills", skill, "SKILL.md")),
			).toBe(true);
		}
	});
}

describe("skill indexes list every Wave 4 skill", () => {
	indexTests("Wave 4", WAVE_4_SKILLS);

	test("docs/DEVELOPER.md lists the retired skills for deletion at cutover", () => {
		const developer = readRepoFile("docs", "DEVELOPER.md").replace(/\s+/g, " ");
		for (const name of ["viz", "review", "lineage", "clockout"])
			expect(developer).toContain(`\`${name}\``);
		expect(developer).toContain("retired, not ported");
		expect(developer).toContain("Delete their local copies at the manual cutover.");
	});
});

describe("skill indexes list every Wave 3 skill", () => {
	indexTests("Wave 3", WAVE_3_SKILLS);

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
});
