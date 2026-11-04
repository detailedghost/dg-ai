import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	count,
	lineWith,
	REPO_ROOT,
	readRepoFile,
	section,
} from "./test-support";

export const MAX_SPEC_SKILL_LINES = 129;
const MIN_SENTENCE_LENGTH = 30;
const STEP_5_LINES_ON_ORIGIN_MASTER = 10;
const STEP_7C_LINES_ON_ORIGIN_MASTER = 8;

const SPEC_DIR = join(REPO_ROOT, "plugins", "dg", "skills", "spec");
const SPEC = ["plugins", "dg", "skills", "spec"];
const REFS = [...SPEC, "references"];

const skill = readRepoFile(...SPEC, "SKILL.md");
const plan = readRepoFile(...REFS, "plan.md");
const execute = readRepoFile(...REFS, "execute.md");
const fast = readRepoFile(...REFS, "fast.md");
const sliceReview = readRepoFile(...REFS, "templates", "slice-review.md");
const planView = readRepoFile(...REFS, "templates", "plan-view.md");

function refText(name: string): string {
	return existsSync(join(SPEC_DIR, "references", name))
		? readRepoFile(...REFS, name)
		: "";
}

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

function flagRow(flag: string): string[] {
	const flags = section(skill, "## Flags", "\n## ");
	const row = flags
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map(cells)
		.find((c) => c[0]?.includes(`\`${flag}`));
	return row ?? [];
}

function sentences(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => !/^\s*(#|\||```|---)/.test(line))
		.join(" ")
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length >= MIN_SENTENCE_LENGTH);
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

function fencedBlocks(text: string): string[] {
	return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

const step5 = section(plan, "## Step 5", "## Step 6");
const step7 = section(plan, "## Step 7", "## Step 8");
const step7c = section(step7, "- c.", "- d.");
const step7d = section(step7, "- d.", "> **GATE:**");
const step8 = section(plan, "## Step 8", "## Step 9");
const step9 = section(plan, "## Step 9", "## Step 10");
const fastF5 = section(fast, "## F5", "## F6");
const fastF7 = section(fast, "## F7", "## F8");
const dispatch = section(skill, "## Mode dispatch", "## Plan-mode pipeline");
const execute1 = section(execute, "## 1.", "## 2.");
const execute4 = section(execute, "## 4.", "## 5.");
const execute5 = section(execute, "## 5.", "## 6.");

describe("spec skill flags", () => {
	test("Usage line names the profile and proxy flags", () => {
		const usage = lineWith(skill, "**Usage:**");
		for (const flag of ["--profile", "--cheap", "--expensive", "--proxy"])
			expect(usage).toContain(flag);
	});

	test("Flags table gives --profile -p and --proxy -x", () => {
		expect(flagRow("--profile")[1]).toContain("-p");
		expect(flagRow("--proxy")[1]).toContain("-x");
	});

	test("Flags table gives --cheap and --expensive no short flag", () => {
		expect(flagRow("--cheap")[1]).toBe("none");
		expect(flagRow("--expensive")[1]).toBe("none");
	});

	test("--profile Effect cell holds the two-profile-flag error", () => {
		const effect = flagRow("--profile")[2] ?? "";
		expect(effect).toMatch(/two profile flags/i);
		expect(effect).toMatch(/error/i);
		expect(effect).toMatch(/both/i);
	});

	test("dispatch validates --proxy against list-backends before any phase", () => {
		expect(dispatch).toContain("--proxy");
		expect(dispatch).toContain("dg-skills proxy --list-backends");
		expect(dispatch).toMatch(/before any phase/);
	});

	test("dispatch rejects a bad --profile value and mixes of --fast with --proxy", () => {
		expect(dispatch).toContain(
			"--profile must be one of balance, cheap, expensive",
		);
		expect(dispatch).toContain(
			"`--fast` is mutually exclusive with `-s` and with `--proxy`",
		);
	});

	test("pipeline row 7 reads --proxy slices", () => {
		expect(lineWith(skill, "| 7 |")).toContain("--proxy slices");
		expect(lineWith(skill, "| 7 |")).not.toContain("assign `/dg:proxy` slices");
	});

	test("pipeline rows 5 and 8 drop escalation and name the profile approval", () => {
		expect(lineWith(skill, "| 5 |")).not.toContain("opt-in escalate");
		expect(lineWith(skill, "| 8 |")).toContain(
			"Plan approval gate (plan view; Approve as a profile, or Rework)",
		);
	});

	test("reference table lists slice-review without the escalation note", () => {
		const row = lineWith(skill, "[references/templates/slice-review.md]");
		expect(row).not.toBe("");
		expect(row).not.toMatch(/escalation/i);
	});

	test("SKILL.md keeps gate and estimate detail out", () => {
		expect(skill).not.toContain("Approve as cheap");
		expect(skill).not.toContain("spec estimate");
	});

	test("SKILL.md stays within the line budget", () => {
		expect(skill.trimEnd().split("\n").length).toBeLessThanOrEqual(
			MAX_SPEC_SKILL_LINES,
		);
	});
});

describe("spec plan mode profile and proxy steps", () => {
	test("step 8 persists the chosen profile through spec set", () => {
		expect(step8).toContain(
			"dg-skills spec set <bundle>/plan.md execution.profile",
		);
	});

	test("step 8 offers four options, or Approve and Rework when a profile flag was given", () => {
		for (const option of [
			"**Approve (balance)**",
			"**Approve as cheap**",
			"**Approve as expensive**",
			"**Rework**",
		])
			expect(step8).toContain(option);
		expect(step8).toMatch(
			/When a profile flag was given, the options are \*\*Approve\*\* and \*\*Rework\*\*/,
		);
	});

	test("step 8 keeps the AskUserQuestion loop and no built-in plan mode", () => {
		expect(step8).toContain("AskUserQuestion");
		expect(step8).toContain("loop until Approve");
		expect(step8).not.toMatch(/ExitPlanMode|EnterPlanMode/);
	});

	test("step 8 reruns the estimate inside the Rework loop", () => {
		expect(step8).toContain("spec estimate");
	});

	test("step 7d estimates cost through spec estimate and keeps the warning", () => {
		expect(step7d).toContain("dg-skills spec estimate <bundle>/plan.md");
		expect(step7d).toContain("--profile");
		expect(step7d).toContain("WARN");
		expect(step7d).toContain("do not persist");
	});

	test("step 7c is conditional on --proxy and skipped without it", () => {
		expect(step7c).toContain("--proxy");
		expect(step7c).toMatch(/skip/i);
		expect(step7c).toContain("agents.proxy");
	});

	test("step 9 states that spec context projects execution.profile", () => {
		expect(step9).toContain("execution.profile");
	});

	test("step 5 drops the per-slice escalate question", () => {
		expect(step5).not.toContain("AskUserQuestion");
		expect(step5).not.toMatch(/escalat/i);
		expect(step5.split("\n").length).toBeLessThan(
			STEP_5_LINES_ON_ORIGIN_MASTER,
		);
	});

	test("step 7c shrinks to a short condition", () => {
		expect(step7c.trimEnd().split("\n").length).toBeLessThan(
			STEP_7C_LINES_ON_ORIGIN_MASTER,
		);
	});

	test("step 3c notes that assign writes agents.complexity", () => {
		expect(plan).toContain("agents.complexity");
	});

	test("plan-view Cost lists one line per profile from spec estimate", () => {
		const cost = planView.split("## Cost")[1] ?? "";
		expect(cost).toMatch(/one line per profile/i);
		expect(cost).toContain("spec estimate");
	});

	test("plan-view closes with the step 8 profile choice", () => {
		expect(planView).toContain(
			"ask per plan.md step 8: Approve (with the profile choice) or Rework",
		);
	});

	test("slice-review has no Escalate slice question and keeps the balance line", () => {
		expect(sliceReview).not.toContain("Escalate slice");
		expect(sliceReview).toContain("sonnet");
		expect(sliceReview).toContain("medium");
	});
});

describe("spec execute mode profile and proxy handling", () => {
	test("execute section 1 reads execution.profile and -s --profile", () => {
		expect(execute1).toContain("execution.profile");
		expect(execute).toContain("-s --profile");
		expect(execute1).toMatch(/balance/);
	});

	test("execute section 5 handles -s --proxy and honors bundle agents.proxy", () => {
		expect(execute5).toContain("-s --proxy");
		expect(execute5).toContain("agents.proxy");
		expect(execute4).not.toContain("-s --proxy");
	});

	test("execute section 5 points at engineering with spec ready --cwd", () => {
		expect(execute5).toContain("spec ready");
		expect(execute5).toContain("--cwd");
		expect(execute5).toContain("engineering.md");
		expect(execute5).toContain("--slices");
	});

	test("execute has no --layer and no assign resolve command block", () => {
		expect(execute).not.toContain("--layer");
		const blocks = fencedBlocks(execute).filter((b) =>
			b.includes("assign resolve"),
		);
		expect(blocks).toEqual([]);
	});
});

describe("spec fast mode profile handling", () => {
	test("fast.md names --fast --cheap and execution.profile", () => {
		expect(fast).toContain("--fast --cheap");
		expect(fast).toContain("execution.profile");
	});

	test("F5 sets the profile and names finish.md step 5", () => {
		expect(fastF5).toContain("execution.profile");
		expect(fastF5).toContain("finish.md step 5");
		expect(fastF5.indexOf("execution.profile")).toBeLessThan(
			fastF5.indexOf("spec context"),
		);
	});

	test("F7 commit subject carries slice-<N>:", () => {
		expect(fastF7).toContain("slice-<N>:");
		expect(fastF7).toContain("<type>(<scope>): slice-<N>: <slice name>");
	});
});

describe("spec lazy profile and proxy references", () => {
	test("profiles.md and proxy.md exist and SKILL.md links both", () => {
		expect(existsSync(join(SPEC_DIR, "references", "profiles.md"))).toBe(true);
		expect(existsSync(join(SPEC_DIR, "references", "proxy.md"))).toBe(true);
		expect(skill).toContain("](references/profiles.md)");
		expect(skill).toContain("](references/proxy.md)");
	});

	test("profiles.md sets execution.profile before spec context", () => {
		const profiles = refText("profiles.md");
		const set = profiles.indexOf("spec set <bundle>/plan.md execution.profile");
		expect(profiles).toContain("execution.profile");
		expect(set).toBeGreaterThanOrEqual(0);
		expect(profiles.indexOf("spec context")).toBeGreaterThan(set);
	});

	test("profiles.md holds the cheap and expensive deltas", () => {
		const profiles = refText("profiles.md");
		expect(profiles).toContain("--cheap");
		expect(profiles).toContain("--expensive");
		expect(profiles).toContain("opus");
	});

	test("proxy.md holds the per-slice question and proxy_skills", () => {
		const proxy = refText("proxy.md");
		expect(proxy).toContain("agents.proxy");
		expect(proxy).toContain("proxy_skills");
	});

	test("plan.md and execute.md link each reference once, fast.md never", () => {
		expect(count(plan, "](profiles.md)")).toBe(1);
		expect(count(execute, "](profiles.md)")).toBe(1);
		expect(count(fast, "](profiles.md)")).toBe(0);
		expect(count(plan, "](proxy.md)")).toBe(1);
		expect(count(execute, "](proxy.md)")).toBe(1);
		expect(fast).not.toContain("profiles.md");
	});

	test("every pointer says only when", () => {
		for (const [text, link] of [
			[plan, "](profiles.md)"],
			[execute, "](profiles.md)"],
			[plan, "](proxy.md)"],
			[execute, "](proxy.md)"],
		] as const) {
			const paragraph = text
				.split(/\n\s*\n/)
				.find((block) => block.includes(link));
			expect(paragraph).toMatch(/only when/i);
		}
	});

	test("no sentence of profiles.md or proxy.md repeats in the entry files", () => {
		const entry = [skill, plan, execute, fast].map((t) =>
			t.replace(/\s+/g, " "),
		);
		const referenceSentences = ["profiles.md", "proxy.md"].map((name) =>
			sentences(refText(name)),
		);
		for (const found of referenceSentences)
			expect(found.length).toBeGreaterThan(0);
		const repeated = referenceSentences
			.flat()
			.filter((s) => entry.some((t) => t.includes(s)));
		expect(repeated).toEqual([]);
	});
});

describe("spec skill text wording", () => {
	test("no file under the spec skill says same-layer or one layer", () => {
		const offenders = walk(SPEC_DIR).filter((file) =>
			/same-layer|one layer/i.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
