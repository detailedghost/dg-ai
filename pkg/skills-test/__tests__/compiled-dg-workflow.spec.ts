import { describe, expect, test } from "bun:test";
import { parseWorkflow, workflowText } from "./workflow-support";

const workflow = parseWorkflow("compiled-dg.yml");
const pullRequest = workflow.on.pull_request as { paths?: string[] } | undefined;

describe("compiled-dg.yml smokes the compiled dg on pull requests without a release", () => {
	test("only a pull request starts it", () => {
		expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
	});

	test("it runs on every pull request without a path filter", () => {
		expect(pullRequest?.paths).toBeUndefined();
	});

	test("the build job gates the idle peak RSS, growth and latency of the linux-x64 dg it built", () => {
		const runs = (workflow.jobs.build?.steps ?? []).map((s) => s.run ?? "").join("\n");
		expect(runs).toContain("bun scripts/ram-budget.ts --dg pkg/launcher/dist/dg-linux-x64 --idle 120 --gate --json ram-results.json");
	});

	test("the build job gates size and skill tokens and writes the size reports", () => {
		const runs = (workflow.jobs.build?.steps ?? []).map((s) => s.run ?? "").join("\n");
		expect(runs).toContain("bun scripts/lean-size.ts --dist size-input --previous previous-release --gate --json budget-measurements/lean-budgets.json");
		expect(runs).toContain("bun scripts/skill-tokens.ts --gate");
		expect(runs).toContain("--report budget-measurements/size-report.json");
		expect(runs).toContain("size-report-base.json");
	});

	test("it uploads the budget-measurements artifact the ratchet reads", () => {
		const upload = (workflow.jobs.build?.steps ?? []).find((s) => s.with?.name === "budget-measurements");
		expect(upload?.with?.path).toBe("budget-measurements/*.json");
	});

	test("the macOS and Windows legs report without gating", () => {
		const report = workflow.jobs.report as { "continue-on-error"?: boolean } | undefined;
		expect(report?.["continue-on-error"]).toBe(true);
		const runs = (workflow.jobs.report?.steps ?? []).map((s) => s.run ?? "").join("\n");
		expect(runs).not.toContain("--gate");
	});

	test("it reads the repo and writes nothing", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflowText("compiled-dg.yml")).not.toMatch(/: write\b|gh release (create|upload|edit|delete)|git push/);
	});

	test("the build job cross-compiles without the companions the way the release does", () => {
		const runs = (workflow.jobs.build?.steps ?? []).map((s) => s.run ?? "");
		expect(runs).toContain(
			"bun run build.ts --outdir dist --compiled linux-x64 --compiled windows-x64 --compiled darwin-arm64 --without-companions",
		);
		expect(workflow.jobs.build?.strategy).toBeUndefined();
	});

	test("the smoke job runs the shared smoke action on a native Linux and Windows runner", () => {
		const smoke = workflow.jobs.smoke;
		const matrix = smoke?.strategy?.matrix?.include ?? [];
		expect(matrix).toEqual([
			{ os: "ubuntu-latest", runtime: "linux-x64" },
			{ os: "windows-latest", runtime: "windows-x64" },
		]);
		expect(smoke?.needs).toBe("build");
		expect((workflow.jobs.build as { outputs?: Record<string, string> }).outputs?.version).toBe(
			"${{ steps.version.outputs.version }}",
		);
		const step = (smoke?.steps ?? []).find((s) => s.uses === "./.github/actions/smoke-compiled-dg");
		expect(step?.with).toEqual({ runtime: "${{ matrix.runtime }}", version: "${{ needs.build.outputs.version }}" });
	});
});
