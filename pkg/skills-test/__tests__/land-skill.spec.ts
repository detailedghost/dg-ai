import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const skillFile = (...parts: string[]) =>
	readRepoFile("plugins", "dg", "skills", ...parts);

const SKILL = skillFile("land", "SKILL.md");
const WORKFLOW = skillFile("land", "references", "workflow.md");
const LAND = `${SKILL}\n${WORKFLOW}`;
const EXECUTE = skillFile("spec", "references", "execute.md");

describe("land skill", () => {
	test("has land front matter", () => {
		expect(SKILL).toMatch(/^---\nname: land\n/);
	});

	test("defaults to three Codex rounds and two CI retries", () => {
		expect(SKILL).toMatch(/\| `--rounds N` \| `-r` \|[^\n]*\| `3` \|/);
		expect(SKILL).toMatch(/\| `--ci-retries N` \| `-c` \|[^\n]*\| `2` \|/);
		expect(SKILL).toMatch(/\| `--proxy <backend>` \| `-p` \|[^\n]*\| `codex` \|/);
	});

	test("refuses the copilot backend before any step", () => {
		expect(WORKFLOW).toContain("`-p copilot` → stop");
		expect(SKILL).toContain("`copilot` is refused");
	});

	test("reviews through review-loop proxy mode and fixes through address", () => {
		expect(WORKFLOW).toContain("/dg:review-loop -p <backend>");
		expect(WORKFLOW).toContain("dg-skills address gather-ci-failures");
		expect(WORKFLOW).toContain("/dg:address -m");
	});

	test("merges only the tested head and deletes the branch", () => {
		expect(WORKFLOW).toContain(
			"gh pr merge <n> --repo <repo> --<method> --delete-branch --match-head-commit <sha>",
		);
	});

	test("prints the merge command with a ! prefix when the harness blocks it", () => {
		expect(WORKFLOW).toContain(
			"`! gh pr merge <n> --repo <repo> --<method> --delete-branch --match-head-commit <sha>`",
		);
		expect(SKILL).toContain("Never work around a blocked merge.");
	});

	test("keeps the merge in the main loop", () => {
		expect(SKILL).toContain("**Only the main loop merges.**");
		expect(WORKFLOW).toContain("AskUserQuestion");
	});

	test("refuses drafts, closed PRs, stacked PRs and other providers", () => {
		for (const state of ["not-github", "not-open", "draft:", "fork:", "stacked:", "dirty:"])
			expect(WORKFLOW).toContain(`land: ${state}`);
	});

	test("sends behind or conflicting PRs to catchup", () => {
		expect(WORKFLOW).toContain("land: needs-catchup: run /dg:catchup");
	});

	test("bounds each CI wait", () => {
		expect(WORKFLOW).toContain(
			"timeout <waitTimeout> gh pr checks <pr> --repo <repo> --watch --fail-fast",
		);
	});

	test("checks the children of the deleted branch", () => {
		expect(WORKFLOW).toContain("gh pr list --base <headRefName> --state open");
	});
});

describe("spec lands its PR by default", () => {
	test("spec documents the --no-land opt-out", () => {
		const spec = skillFile("spec", "SKILL.md");
		expect(spec).toContain("[--no-land]");
		expect(spec).toMatch(/\| `--no-land` \| none \|/);
	});

	test("execute mode marks the PR ready and runs land in the main loop", () => {
		expect(EXECUTE).toContain("## 7. Land the PR — the default end");
		expect(EXECUTE).toContain("gh pr ready <number>");
		expect(EXECUTE).toContain("[`land/SKILL.md`](../../land/SKILL.md)");
		expect(EXECUTE).toContain("No subagent, slice agent, or `/dg:proxy` backend runs");
	});

	test("fast mode and --bg follow the execute rule", () => {
		expect(skillFile("spec", "references", "fast.md")).toContain(
			"[execute.md](execute.md) §7 applies unchanged",
		);
		expect(skillFile("spec", "references", "bg.md")).toContain(
			"A `--bg` run skips [execute.md](execute.md) §7",
		);
	});

	test("pickup passes --no-land through", () => {
		const pickup = skillFile("pickup", "SKILL.md");
		expect(pickup).toContain("**Usage:** `/dg:pickup [NNN-or-substring] [--no-land]`");
		expect(pickup).toContain("plus `--no-land` when given");
	});

	test("plain sdlc keeps its draft-only finish", () => {
		expect(skillFile("sdlc", "references", "finish.md")).not.toContain("/dg:land");
	});
});
