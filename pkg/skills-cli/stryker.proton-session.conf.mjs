// @ts-check
/** Mutation test for the Proton pw profile glue: request-log reading, marker and lock. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: [
		// The request-log reading this config was added for; the rest of the file predates it.
		"src/inbox/proton-pw.ts:196-211",
		"src/inbox/proton-pw.ts:280-330",
	],
	testFiles: ["__tests__/inbox-proton-pw.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation/proton-session.json" },
	thresholds: { high: 90, low: 80, break: null },
	tempDirName: ".stryker-tmp",
};

export default config;
