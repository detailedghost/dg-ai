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
	"viz",
	"review",
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

	test("docs/install.md states Bun as the viz runtime prerequisite", () => {
		const install = readRepoFile("docs", "install.md");
		const vizLine = install
			.split("\n")
			.find((line) => line.includes("`viz`") && /bun/i.test(line));
		expect(vizLine).toBeDefined();
	});

	test("every indexed Wave 3 skill ships a SKILL.md", () => {
		for (const skill of WAVE_3_SKILLS) {
			expect(
				existsSync(join(REPO_ROOT, "plugins", "dg", "skills", skill, "SKILL.md")),
			).toBe(true);
		}
	});
});
