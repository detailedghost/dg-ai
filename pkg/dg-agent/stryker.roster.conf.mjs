/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: ["src/phone/names.ts", "src/phone/roster.ts"],
	testFiles: ["__tests__/phone/roster.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/roster-mutation.json" },
	thresholds: { high: 80, low: 70, break: 70 },
	tempDirName: ".stryker-tmp",
};

export default config;
