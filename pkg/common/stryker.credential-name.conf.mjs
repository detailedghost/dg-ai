/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: ["src/credentials-format.ts:89-107", "src/credentials-format.ts:114-114", "src/credentials-format.ts:219-221"],
	testFiles: ["__tests__/credentials-format.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/credential-name-mutation.json" },
	thresholds: { high: 100, low: 100, break: 100 },
	tempDirName: ".stryker-tmp",
};

export default config;
