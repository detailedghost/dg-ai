// @ts-check
/** Mutation test for the verify manifest gate and the local axe summary. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 2,
	mutate: [
		"src/verify/axe.ts",
		"src/verify/manifest.ts",
		"src/verify/names.ts",
		"src/verify/urls.ts",
		"src/verify/capture-model.ts",
	],
	testFiles: [
		"__tests__/verify-axe.spec.ts",
		"__tests__/verify-manifest.spec.ts",
		"__tests__/verify-capture.spec.ts",
	],
	reporters: ["clear-text", "progress"],
	thresholds: { high: 80, low: 70, break: 70 },
	tempDirName: ".stryker-tmp",
	bun: { timeout: 60_000 },
};

export default config;
