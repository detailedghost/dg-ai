// @ts-check
/** Mutation test for the Proton pw request log: authenticated-session headers and the refresh-safe reset. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: ["src/inbox/proton-request-log.ts"],
	testFiles: ["__tests__/inbox-proton-pw.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation/proton-session.json" },
	thresholds: { high: 90, low: 80, break: 80 },
	tempDirName: ".stryker-tmp",
};

export default config;
