import { describe, expect, test } from "bun:test";
import { readRepoFile, section } from "./test-support";

const SKILLS = ["plugins", "dg", "skills"];
const step8 = section(
	readRepoFile(...SKILLS, "spec", "references", "plan.md"),
	"## Step 8",
	"## Step 9",
);
const view = readRepoFile(
	...SKILLS,
	"spec",
	"references",
	"templates",
	"plan-view.md",
);

describe("plan approval gate", () => {
	test("step 8 prints the plan view and asks Approve or Rework", () => {
		expect(step8).toContain("templates/plan-view.md");
		expect(step8).toContain("AskUserQuestion");
		expect(step8).toContain("Approve");
		expect(step8).toContain("Rework");
		expect(step8).toContain("loop until Approve");
	});

	test("step 8 persists the profile choice", () => {
		expect(step8).toContain("execution.profile");
	});

	test("step 8 no longer uses the built-in plan mode or the viz board", () => {
		expect(step8).not.toMatch(/ExitPlanMode|EnterPlanMode|\/viz/);
	});

	test("the view template flags review items with the eyes marker and lists them first", () => {
		expect(view).toContain("👀 Check these");
		expect(view.indexOf("## 👀 Check these")).toBeLessThan(
			view.indexOf("## Purpose"),
		);
		expect(view).toContain("Approve");
		expect(view).toContain("Rework");
	});

	test("kick and prd run the same gate through spec plan mode", () => {
		for (const skill of ["kick", "prd"]) {
			expect(readRepoFile(...SKILLS, skill, "SKILL.md")).toContain(
				"plan approval gate",
			);
		}
	});

	test("fast mode keeps the built-in plan mode gate", () => {
		expect(readRepoFile(...SKILLS, "spec", "references", "fast.md")).toContain(
			"`ExitPlanMode` is fast mode's approval gate",
		);
	});
});
