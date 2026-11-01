import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOKS } from "../../skills-cli/src/hooks/manifest";
import { REPO_ROOT, readRepoFile } from "./test-support";

const SKILL = ["plugins", "dg", "skills", "hooks", "SKILL.md"];
const MAX_SKILL_LINES = 60;

function skillText(): string {
	return readRepoFile(...SKILL);
}

describe("hooks skill", () => {
	test("is packaged with hooks front matter", () => {
		expect(existsSync(join(REPO_ROOT, ...SKILL))).toBe(true);
		expect(skillText()).toMatch(/^---\nname: hooks\n/);
	});

	test("stays within the line budget", () => {
		expect(skillText().trimEnd().split("\n").length).toBeLessThanOrEqual(
			MAX_SKILL_LINES,
		);
	});

	test("lists every manifest hook id", () => {
		const text = skillText();
		const missing = HOOKS.map((hook) => hook.id).filter(
			(id) => !text.includes(`\`${id}\``),
		);
		expect(missing).toEqual([]);
	});

	test("gives the status, enable and disable commands", () => {
		const text = skillText();
		for (const sub of ["status", "enable", "disable"])
			expect(text).toContain(`dg-skills hooks ${sub}`);
	});

	test("tells the agent to report status per runtime", () => {
		expect(skillText()).toMatch(/hooks status`[^\n]*Report per runtime\./);
	});

	test("tells the agent to ask before enabling anything", () => {
		const text = skillText().replace(/\s+/g, " ");
		expect(text).toMatch(/Ask the user before enabling any hook\./);
		expect(text).toMatch(/Run `enable` only after the user answers yes\./);
	});

	test("links docs/hooks.md at its repo path", () => {
		const link = /\]\(([^)]*)\)/g;
		const targets = [...skillText().matchAll(link)].map((m) => m[1]);
		const docs = targets.filter((t) => t.endsWith("docs/hooks.md"));
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatch(
			/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/docs\/hooks\.md$/,
		);
		expect(existsSync(join(REPO_ROOT, "docs", "hooks.md"))).toBe(true);
	});

	test("carries the doctor line for hooks", () => {
		expect(skillText()).toMatch(
			/^If a step fails, run ~\/\.dg\/bin\/dg-skills doctor hooks\.$/m,
		);
	});

	test("carries no machine-local paths", () => {
		expect(skillText()).not.toMatch(
			/\/home\/|~\/\.claude|~\/scripts|\/mnt\/c\//,
		);
	});
});

describe("hook-comment-disable skill", () => {
	const path = ["plugins", "dg", "skills", "hook-comment-disable", "SKILL.md"];

	test("points at the spelling hook and dg-skills hooks", () => {
		const text = readRepoFile(...path);
		expect(text).toContain("spelling");
		expect(text).toContain("dg-skills hooks");
		expect(text).not.toContain("american-english-hook.sh");
	});

	test("keeps the marker path under the hooks scratch bucket", () => {
		expect(readRepoFile(...path)).toContain(
			"stash -G hooks comment-disabled.${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-NOSESSION}}",
		);
	});
});

describe("hooks documentation", () => {
	test("docs/hooks.md names every manifest id", () => {
		const text = readRepoFile("docs", "hooks.md");
		const missing = HOOKS.map((hook) => hook.id).filter(
			(id) => !text.includes(`\`${id}\``),
		);
		expect(missing).toEqual([]);
	});

	test("ADR 0026 exists and the toc lists it", () => {
		expect(
			existsSync(join(REPO_ROOT, "docs", "adr", "0026-opt-in-hooks.md")),
		).toBe(true);
		expect(readRepoFile("docs", "adr", "toc.md")).toContain(
			"0026-opt-in-hooks.md",
		);
	});
});
