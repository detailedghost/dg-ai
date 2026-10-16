// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	concurrency: 2,
	mutate: ["src/runners/**/*.ts"],
	testFiles: [
		"__tests__/runners-capture.spec.ts",
		"__tests__/runners-cli-fixture.spec.ts",
		"__tests__/runners-cli-live.spec.ts",
		"__tests__/runners-grok-stream.spec.ts",
		"__tests__/runners-index.spec.ts",
		"__tests__/runners-probe.spec.ts",
		"__tests__/runners-spawn.spec.ts",
	],
	reporters: ["clear-text", "progress", "json"],
	thresholds: { high: 95, low: 90, break: 90 },
	bun: {
		timeout: 120_000,
		// Live CLI tests stay skipped. A signed-out binary on PATH must not fail the dry run.
		env: {
			DG_TEST_CLAUDE_CLI: "0",
			DG_TEST_GROK_CLI: "0",
		},
	},
};
