import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const SKILLS = join(REPO_ROOT, "plugins", "dg", "skills");

describe("review-loop cross-skill reference", () => {
	test("SKILL.md links the sibling review skill relatively", () => {
		const skill = readRepoFile("plugins", "dg", "skills", "review-loop", "SKILL.md");
		const link = /\]\((\.\.\/review\/[^)]*)\)/.exec(skill)?.[1];

		expect(link).toBeDefined();
		expect(existsSync(join(SKILLS, "review-loop", link ?? "missing"))).toBe(true);
	});
});
