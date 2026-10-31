/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: [
		"src/phone/admit-pass.ts",
		"src/phone/since.ts",
		"src/phone/ensure.ts",
		"src/phone/watch.ts",
		"src/phone/chat.ts",
		"src/phone/thread.ts",
		"src/phone/thread-schema.ts",
	],
	testFiles: [
		"__tests__/phone/admit-pass.spec.ts",
		"__tests__/phone/chat.spec.ts",
		"__tests__/phone/commands.spec.ts",
		"__tests__/phone/ensure.spec.ts",
		"__tests__/phone/reconnect.spec.ts",
		"__tests__/phone/listener.spec.ts",
		"__tests__/phone/db.spec.ts",
		"__tests__/phone/thread.spec.ts",
		"__tests__/phone/thread-migrate.spec.ts",
		"__tests__/phone/thread-live.spec.ts",
	],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/phone-mutation.json" },
	thresholds: { high: 90, low: 85, break: 85 },
	tempDirName: ".stryker-tmp",
};

export default config;
