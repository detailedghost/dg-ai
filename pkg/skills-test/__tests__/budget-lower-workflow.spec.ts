import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "./workflow-support";

const workflow = parseWorkflow("budget-lower.yml");
const compiled = parseWorkflow("compiled-dg.yml");
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

	test("it waits only for a run it dispatched and skips a run that did not succeed", () => {
		expect(runs).toContain("--event workflow_dispatch --branch master");
		expect(runs).toContain('select(. as $id | ($known | contains(" \\($id) ")) | not)');
		expect(runs).toContain("--exit-status");
	});

	test("it downloads only the measurement artifacts and stages them flat", () => {
		expect(runs).toContain("--name budget-measurements --dir m-compiled-dg");
		expect(runs).toContain("--pattern 'native-budget-measurements-*' --dir m-native");
		expect(runs).toContain("--pattern 'bench-measurements-*' --dir m-native-bench");
		expect(runs).toContain("m-compiled-dg/*.json m-native/native-budget-measurements-*/*.json m-native-bench/bench-measurements-*/*.json");
	});

	test("each run uses its own branch and closes the older weekly pull request", () => {
		expect(runs).toContain('branch="chore/lower-budgets-$(date -u +%Y-%m-%d)-$GITHUB_RUN_ID"');
		expect(runs).toContain("gh pr close");
		expect(runs).toContain("git add scripts/*.json native/budgets native/bench/Dg.Bench/budgets");
	});

	test("compiled-dg skips the base size report outside a pull request", () => {
		const guarded = (compiled.jobs.build?.steps ?? []).filter((s) => (s.name ?? "").includes("base commit"));
		expect(guarded).toHaveLength(2);
		for (const step of guarded) expect(String(step.if)).toContain("github.event_name == 'pull_request'");
	});
});
