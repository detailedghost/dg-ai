import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "./workflow-support";

const workflow = parseWorkflow("budget-lower.yml");
const runs = (workflow.jobs.lower?.steps ?? []).map((s) => s.run ?? "").join("\n");

describe("budget-lower.yml lowers budgets from a weekly measurement of master", () => {
	test("a weekly schedule or a manual dispatch starts it", () => {
		expect(Object.keys(workflow.on)).toEqual(["schedule", "workflow_dispatch"]);
	});

	test("it measures master with every workflow that uploads budget measurements", () => {
		for (const wf of ["compiled-dg.yml", "native.yml", "native-bench.yml"]) expect(runs).toContain(wf);
	});

	test("it lowers budgets with the ratchet and opens a pull request instead of pushing to master", () => {
		expect(runs).toContain("bun scripts/budget-ratchet.ts --lower");
		expect(runs).toContain("gh pr create --base master");
		expect(runs).not.toContain("git push origin master");
	});
});
