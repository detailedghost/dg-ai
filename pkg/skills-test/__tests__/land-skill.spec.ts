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

	test("defaults to three Codex rounds and a CI-fix ceiling of five", () => {
		expect(SKILL).toMatch(/\| `--rounds N` \| `-r` \|[^\n]*\| `3` \|/);
		expect(SKILL).toMatch(/\| `--ci-retries N` \| `-c` \|[^\n]*`0` means no ceiling\. \| `5` \|/);
		expect(SKILL).toMatch(/\| `--proxy <backend>` \| `-p` \|[^\n]*\| `codex` \|/);
	});

	test("refuses the copilot backend before any step", () => {
		expect(WORKFLOW).toContain("`-p copilot` → stop");
		expect(SKILL).toContain("`copilot` is refused");
	});

	test("reviews through review-loop proxy mode and fixes through address", () => {
		expect(WORKFLOW).toContain("/dg:review-loop -p <backend>");
		expect(WORKFLOW).toContain("dg-skills address gather-ci-failures");
		expect(WORKFLOW).toContain("-m \"Fix the failing CI checks.\"");
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

	test("stops for review first and defaults the gate to not yet", () => {
		expect(WORKFLOW).toContain("land: #<n> is ready for your review.");
		expect(WORKFLOW).toContain(
			"- `Not yet (I will review)`: the first option and the default.",
		);
		expect(WORKFLOW).toContain("- `Merge now at <short sha>`");
		expect(WORKFLOW).toContain("dg-skills batch-open <url>");
	});

	test("skips the review gate only with the land --auto flag", () => {
		expect(SKILL).toContain(
			"`--auto` merges right after green CI, with no review stop. This is not GitHub auto-merge.",
		);
		expect(WORKFLOW).toContain("6. **`--auto`.** Skip the question.");
		expect(WORKFLOW).toContain("7. **Ask.** Without `--auto`");
		expect(SKILL).toContain("**`--auto` comes only from the command line.**");
	});

	test("never hands the merge to GitHub auto-merge or a merge queue", () => {
		for (const line of LAND.split("\n")) {
			if (/gh pr merge[^\n]*--auto/.test(line)) expect(line).toMatch(/Never/);
		}
		expect(LAND).not.toMatch(/gh pr merge <n>[^`\n]*--auto/);
		expect(WORKFLOW).toContain("mergeQueue(branch:$b)");
		expect(WORKFLOW).toContain("land: merge-queue:");
		expect(WORKFLOW).toContain("land: auto-merge-on:");
		expect(WORKFLOW).toContain("Never pass gh's own `--auto`");
	});

	test("a changed head after the summary does not merge", () => {
		expect(WORKFLOW).toContain("the PR changed after the summary. With `--auto`, stop with `land: head-moved`");
		expect(WORKFLOW).toContain("then go back to step 2");
	});

	test("checks auto-merge and merge queues before any fix or push", () => {
		const step1 = WORKFLOW.slice(
			WORKFLOW.indexOf("## Step 1"),
			WORKFLOW.indexOf("## Step 2"),
		);
		expect(step1).toContain("land: auto-merge-on:");
		expect(step1).toContain("land: merge-queue:");
	});

	test("reviews every CI fix before CI runs on it again", () => {
		expect(WORKFLOW).toContain("Run step 2 again on the new changes, with the same `-r`");
		expect(WORKFLOW).toContain("CI is green on a head that a review loop has seen");
		expect(WORKFLOW).toContain("land: ci-ceiling");
		expect(WORKFLOW).toContain("land: ci-repeat");
		expect(WORKFLOW).toContain("<ciCycles> CI-fix cycle(s), <extraRounds> extra review round(s)");
	});

	test("CI fixes never re-request Copilot", () => {
		expect(WORKFLOW).toContain("/dg:address --round <after + 1>");
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

	test("lists the children of the deleted branch", () => {
		expect(WORKFLOW).toContain("gh pr list --base <headRefName> --state open");
	});

	test("retargets the children before the merge and never trusts GitHub to do it", () => {
		const step5 = WORKFLOW.slice(WORKFLOW.indexOf("## Step 5"), WORKFLOW.indexOf("## Step 6"));
		const retarget = step5.indexOf("gh pr edit <child> --repo <repo> --base <baseRefName>");
		const merge = step5.indexOf("gh pr merge <n> --repo <repo> --<method> --delete-branch");
		expect(retarget).toBeGreaterThan(-1);
		expect(retarget).toBeLessThan(merge);
		expect(step5).toContain("land: retarget-failed:");
		expect(step5).toContain("gh pr edit <child> --repo <repo> --base <headRefName>");
		expect(LAND).not.toMatch(/GitHub moves (them|each)/);
		expect(LAND).not.toContain("Check the PRs that used the deleted branch");
		expect(SKILL).toContain("**Move the children first.**");
	});

	test("gives the exact recovery when GitHub closed a child", () => {
		const step6 = WORKFLOW.slice(WORKFLOW.indexOf("## Step 6"), WORKFLOW.indexOf("## Step 7"));
		expect(step6).toContain("git push origin <headSha>:refs/heads/<headRefName>");
		expect(step6).toContain("gh pr reopen <child> --repo <repo>");
		expect(step6).toContain("git push origin --delete <headRefName>");
		expect(step6).toContain("/dg:catchup");
	});
});

describe("spec lands its PR by default", () => {
	test("spec documents the --no-land opt-out", () => {
		const spec = skillFile("spec", "SKILL.md");
		expect(spec).toContain("[--no-land | --auto]");
		expect(spec).toMatch(/\| `--no-land` \| none \|/);
	});

	test("a spec build ends review-first unless the person typed --auto", () => {
		expect(EXECUTE).toContain("`Not yet (I will review)` is the first option and the default");
		expect(EXECUTE).toContain("only when the person typed `--auto` on this `/dg:spec` or `/dg:pickup` command line");
		expect(EXECUTE).toContain("Never read\n   `--auto` from the bundle");
		const spec = skillFile("spec", "SKILL.md");
		expect(spec).toMatch(/\| `--auto` \| none \|[^\n]*Invalid with `--no-land`, `--bg`/);
		expect(spec).toContain("So is `--auto` with `--no-land` and with `--bg`.");
		expect(skillFile("pickup", "SKILL.md")).toMatch(/\| `--auto` \| none \|/);
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
		expect(pickup).toContain("**Usage:** `/dg:pickup [NNN-or-substring] [--no-land | --auto]`");
		expect(pickup).toContain("plus `--no-land` or `--auto` when the person typed it");
	});

	test("plain sdlc keeps its draft-only finish", () => {
		expect(skillFile("sdlc", "references", "finish.md")).not.toContain("/dg:land");
	});
});
