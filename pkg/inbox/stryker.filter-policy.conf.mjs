// @ts-check
/** Mutation testing for the Proton filter plan and its safety checks. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: [
		"src/features/filter-policy/plan.ts",
		"src/features/filter-policy/safety.ts",
	],
	testFiles: [
		"src/features/filter-policy/__tests__/plan.spec.ts",
		"src/features/filter-policy/__tests__/safety.spec.ts",
		"src/features/filter-policy/__tests__/apply.spec.ts",
		"src/features/filter-policy/__tests__/sync.spec.ts",
	],
	bun: {
		timeout: 60_000,
	},
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation/filter-policy.json" },
	thresholds: { high: 90, low: 80, break: 80 },
	tempDirName: ".stryker-tmp",
};

export default config;
