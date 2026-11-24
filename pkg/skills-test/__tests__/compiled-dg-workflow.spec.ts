import { describe, expect, test } from "bun:test";
import { parseWorkflow, workflowText } from "./workflow-support";

const workflow = parseWorkflow("compiled-dg.yml");
const pullRequest = workflow.on.pull_request as { paths?: string[] } | undefined;

describe("compiled-dg.yml smokes the compiled dg on pull requests without a release", () => {
	test("only a pull request starts it", () => {
		expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
	});

	test("its path filter covers every tree in the binary, the RAM harness, the smoke action and the workflows that build dg", () => {
		expect(pullRequest?.paths).toEqual(
			expect.arrayContaining([
				"pkg/launcher/**",
				"pkg/dg/**",
				"pkg/common/**",
				"pkg/skills-cli/**",
				"pkg/dg-agent/**",
				"pkg/dg-daemon/**",
				"scripts/ram-budget.ts",
				"scripts/ram-budget/**",
				".github/actions/smoke-compiled-dg/**",
				".github/workflows/compiled-dg.yml",
				".github/workflows/release.yml",
			]),
		);
	});

	test("the build job gates the peak RSS of the linux-x64 dg it built", () => {
		const runs = (workflow.jobs.build?.steps ?? []).map((s) => s.run ?? "");
		expect(runs).toContain("bun scripts/ram-budget.ts --dg pkg/launcher/dist/dg-linux-x64 --gate");
	});

	test("it reads the repo and writes nothing", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflowText("compiled-dg.yml")).not.toMatch(/: write\b|gh release|git push/);
	});

	test("the build job cross-compiles linux-x64 and windows-x64 the way the release does", () => {
		const runs = (workflow.jobs.build?.steps ?? []).map((s) => s.run ?? "");
		expect(runs).toContain("bun run build.ts --outdir dist --compiled linux-x64 --compiled windows-x64");
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
