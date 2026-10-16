// @ts-check
/** Mutation test for the skills-only file list and copy. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	concurrency: 2,
	mutate: ["src/skill-files.ts", "src/node/install-skills.ts"],
	testFiles: [
		"__tests__/skill-files.spec.ts",
		"__tests__/install-skills.spec.ts",
	],
	reporters: ["clear-text", "progress"],
	thresholds: { high: 90, low: 80, break: 90 },
	tempDirName: ".stryker-tmp",
};

export default config;
