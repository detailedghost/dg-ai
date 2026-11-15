// @ts-check
/** Mutation test for the Proton pw session wait, sign-out detection and refresh retry. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: ["src/protonmail/pw-client.ts"],
	testFiles: ["src/protonmail/__test__/pw-client.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation/proton-session.json" },
	thresholds: { high: 90, low: 80, break: 80 },
	tempDirName: ".stryker-tmp",
};

export default config;
