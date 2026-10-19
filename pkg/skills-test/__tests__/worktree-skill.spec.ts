import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(
	import.meta.dir,
	"../../../plugins/dg/skills/worktree/SKILL.md",
);

describe("packaged worktree skill", () => {
	test("ships a SKILL.md that calls the migrated dg-skills worktree command, not the legacy script", () => {
		expect(existsSync(SKILL)).toBe(true);
		const text = readFileSync(SKILL, "utf8");
		expect(text).toMatch(/^name: worktree$/m);
		expect(text).toContain("worktree create");
		expect(text).toContain("worktree remove");
		expect(text).not.toContain("worktree-cli");
		expect(text).not.toMatch(/^(argument-hint|user-invocable):/m);
	});

	test("documents the KEY=value contract and the remove guards", () => {
		const text = readFileSync(SKILL, "utf8");
		for (const key of [
			"WORKTREE_PATH",
			"WORKTREE_BRANCH",
			"WORKTREE_ORIGIN",
			"--force",
			"--merged-ok",
			"--keep-branch",
		])
			expect(text).toContain(key);
	});
});
