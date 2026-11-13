/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 2,
	mutate: [
		"src/store/credentials-store.ts:160-170",
		"src/store/credentials-store.ts:181-201",
		"src/store/credentials-store.ts:226-230",
		"src/store/credentials-store.ts:234-240",
		"src/store/credentials-store.ts:245-248",
		"src/store/credentials-store.ts:251-265",
		"src/store/credentials-store.ts:287-291",
	],
	testFiles: ["__tests__/store/credentials-store.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/credential-name-mutation.json" },
	thresholds: { high: 100, low: 100, break: 100 },
	tempDirName: ".stryker-tmp",
};

export default config;
