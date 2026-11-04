import { describe, expect, test } from "bun:test";
import { count, flagRow, readRepoFile, section } from "./test-support";

const REFS = ["plugins", "dg", "skills", "spec", "references"];

const skill = readRepoFile("plugins", "dg", "skills", "spec", "SKILL.md");
const execute = readRepoFile(...REFS, "execute.md");
const bg = readRepoFile(...REFS, "bg.md");
const PERMISSION_KEYS = [
	"run_commands",
	"git_push",
	"gh_pr_create",
	"auto_cleanup_worktree",
	"slice_commits",
	"housekeeping_commit",
];

function sentenceContaining(text: string, needle: string): string {
	return (
		text
			.replace(/\s+/g, " ")
			.split(/(?<=[.!?])\s+/)
			.find((s) => s.includes(needle)) ?? ""
	);
}

describe("spec --bg flag row", () => {
	test("Flags table has a --bg row with short -b", () => {
		const row = flagRow(skill, "--bg");
		expect(row).not.toEqual([]);
		expect(row[1]).toContain("-b");
	});

	test("the --bg row says execute mode only, unattended, and points at /dg:bg", () => {
		const effect = flagRow(skill, "--bg")[2] ?? "";
		expect(effect).toMatch(/execute mode/i);
		expect(effect).toContain("-s");
		expect(effect).toContain("unattended");
		expect(effect).toContain("/dg:bg");
		expect(effect).toMatch(/invalid with bare plan mode/i);
	});

	test("SKILL.md reference-files table lists references/bg.md", () => {
		expect(skill).toContain("references/bg.md");
	});

	test("Usage line names --bg", () => {
		const usage = skill.split("\n").find((l) => l.startsWith("**Usage:**"));
		expect(usage ?? "").toContain("--bg");
	});
});

describe("spec execute.md section 1 open-deferral check", () => {
	const s1 = section(execute, "## 1.", "\n## 2.");

	test("lists open rows with issues list --open and filters on the deferral from column", () => {
		expect(s1).toContain("issues list");
		expect(s1).toContain("--open");
		expect(s1).toMatch(/`from`/);
		expect(s1).toContain("deferral");
	});

	test("resolves asked rows through issues resolve", () => {
		expect(s1).toContain("issues resolve");
	});

	test("resume uses the default selection and never --slices", () => {
		expect(s1).toContain("default selection");
		expect(s1).toContain("assign resolve");
		expect(s1).not.toContain("--slices");
	});

	test("with --bg and open rows the run stops and prints them", () => {
		const sentence = sentenceContaining(s1, "With `--bg` and open rows");
		expect(sentence).toMatch(/\bstop\b/i);
		expect(sentence).toMatch(/\bprint\b/i);
	});

	test("resolved prefix is best effort and a resumed slice re-runs red, in section 5", () => {
		const s5 = section(execute, "## 5.", "\n## 6.");
		expect(s1).toContain("§5");
		expect(s5).toContain("resolved");
		expect(s5).toMatch(/best effort/i);
		expect(s5).toContain("redDone");
	});
});

describe("spec execute.md bg.md wiring", () => {
	test("execute.md names references/bg.md exactly once", () => {
		expect(
			count(execute, "references/bg.md") + count(execute, "](bg.md)"),
		).toBe(1);
	});

	test("section 2 states a resume derives the same slug so the worktree is reused", () => {
		const s2 = section(execute, "## 2.", "\n## 3.");
		expect(s2).toMatch(/same slug/i);
		expect(s2).toContain("<NNN>_<slug>");
		expect(s2).toMatch(/uncommitted/i);
	});
});

describe("spec bg.md unattended contract", () => {
	test("--bg is valid only with -s and bare plan mode stops", () => {
		const text = bg.replace(/\s+/g, " ");
		expect(text).toMatch(/valid only with `-s`/);
		expect(text).toMatch(/bare plan mode with `--bg` stops/);
	});

	test("records deferrals through issues add from deferral at high severity", () => {
		expect(bg).toContain("issues add");
		expect(bg).toContain("--from deferral");
		expect(bg).toContain("--severity high");
	});

	test("records SPEC, TEST and CRITICAL deferrals and never CONFIRM", () => {
		for (const type of ["SPEC", "TEST", "CRITICAL"]) expect(bg).toContain(type);
		expect(bg).toMatch(/CONFIRM[^.]*never recorded/i);
	});

	test("records unverified results with an UNVERIFIED: description", () => {
		expect(bg).toContain("UNVERIFIED:");
		expect(bg).toContain("unverified");
	});

	test("sanitizes the desc text: pipe becomes slash, newlines collapse, quotes escape", () => {
		const sentence = sentenceContaining(bg, "`|`");
		expect(sentence).toContain("`/`");
		expect(bg).toMatch(/newlines? collapsed/i);
		expect(bg).toContain("'\\''");
	});

	test("names all six permission keys and perms-batch --grant-all", () => {
		for (const key of PERMISSION_KEYS) expect(bg).toContain(key);
		expect(bg).toContain("perms-batch");
		expect(bg).toContain("--grant-all");
	});

	test("launch is the first assign resolve call", () => {
		expect(bg).toContain("assign resolve");
		expect(bg).toMatch(/first `assign resolve`/);
	});

	test("AskUserQuestion is never called after launch", () => {
		expect(bg).toMatch(/AskUserQuestion/);
		expect(sentenceContaining(bg, "AskUserQuestion")).toMatch(
			/(no|never)[^.]*AskUserQuestion|AskUserQuestion[^.]*never/i,
		);
		expect(sentenceContaining(bg, "AskUserQuestion")).toMatch(/launch/);
	});

	test("agents.proxy slices run unprompted", () => {
		expect(bg).toContain("agents.proxy");
		expect(bg).toMatch(/unprompted/);
	});

	test("skips a recorded slice and every transitive dependent from depends_on at commit", () => {
		const sentence = sentenceContaining(bg, "transitive dependent");
		expect(sentence).toContain("depends_on");
		expect(sentence).toMatch(/skipped/);
		expect(bg).toMatch(/independent slices/i);
	});

	test("prints the pause line with the open deferral count and a flagless resume", () => {
		expect(bg).toContain("Run paused with");
		expect(bg).toContain("Resume with /dg:spec -s <NNN>_<slug>");
		expect(bg).toContain("## Issues Remediation");
		expect(bg).toContain("finish.md 5-8");
	});

	test("hybrid finish 5.c: CRITICAL or HIGH-security residual pauses, others go to Known Issues", () => {
		const hybrid = bg.replace(/\s+/g, " ");
		expect(hybrid).toContain("5.c");
		expect(hybrid).toMatch(/CRITICAL or HIGH-security/);
		expect(hybrid).toContain("## Known Issues (Deferred)");
		expect(hybrid).toMatch(/before step 8/);
	});

	test("worktree is reused on resume and never removed on pause", () => {
		const text = bg.replace(/\s+/g, " ");
		expect(text).toMatch(/never removed on pause/i);
		expect(text).toMatch(/reused on resume/i);
	});

	test("bg.md puts the open-row check ahead of launch in order", () => {
		const steps = bg.split("\n").filter((line) => /^\d+\. /.test(line));
		const order = [
			"execute.md",
			"--profile",
			"permissions check",
			"--proxy",
		].map((needle) => steps.findIndex((line) => line.includes(needle)));
		expect(order).toEqual([0, 1, 2, 3]);
	});
});
