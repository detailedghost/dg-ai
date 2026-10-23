// @ts-check
/** Mutation testing for phone-friend delivery. Run from pkg/dg-agent: bunx stryker run */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 2,
	mutate: ["src/phone-friend/deliver.ts"],
	testFiles: ["__tests__/phone-friend/deliver.spec.ts"],
	reporters: ["clear-text", "progress", "json"],
	thresholds: { high: 90, low: 80, break: 80 },
	bun: {
		timeout: 60_000,
	},
};
