/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 2,
	mutate: [
		"src/safety/send-gate.ts",
		"src/classifier/classify.ts",
		"src/privacy/redact.ts",
		"src/pace/jitter.ts",
		"src/cli/authorize.ts",
		"src/google/page.ts",
	],
	testFiles: [
		"__tests__/send-gate.spec.ts",
		"__tests__/classify.spec.ts",
		"__tests__/redact.spec.ts",
		"__tests__/jitter.spec.ts",
		"__tests__/cleanup.spec.ts",
		"__tests__/cli.spec.ts",
		"__tests__/google-page.spec.ts",
	],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation/ssms.json" },
	thresholds: { high: 90, low: 80, break: 80 },
	tempDirName: ".stryker-tmp",
};

export default config;
