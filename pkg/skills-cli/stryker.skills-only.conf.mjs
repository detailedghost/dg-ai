// @ts-check
/** Mutation test for install --skills-only. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 2,
	mutate: ["src/commands/skills-only.ts"],
	testFiles: ["__tests__/skills-only.spec.ts"],
	reporters: ["clear-text", "progress"],
	thresholds: { high: 90, low: 80, break: 90 },
	tempDirName: ".stryker-tmp",
	bun: { timeout: 60_000 },
};

export default config;
