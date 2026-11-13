/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	inPlace: true,
	concurrency: 4,
	mutate: [
		"src/phone/vault.ts:43-55",
		"src/phone/vault.ts:63-64",
		"src/phone/vault.ts:72-92",
		"src/phone/vault.ts:127-133",
		"src/phone/vault.ts:138-144",
		"src/phone/vault.ts:146-149",
		"src/phone/vault.ts:183-189",
		"src/phone/vault.ts:214-226",
		"src/phone/vault.ts:376-380",
		"src/phone/vault-commands.ts:74-75",
		"src/phone/vault-commands.ts:99-102",
		"src/phone/vault-commands.ts:129-132",
		"src/phone/db.ts:462-464",
		"src/phone/db.ts:479-481",
		"src/phone/db.ts:493-495",
	],
	testFiles: ["__tests__/phone/vault.spec.ts", "__tests__/phone/vault-commands.spec.ts"],
	bun: { timeout: 60_000 },
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/vault-name-mutation.json" },
	thresholds: { high: 100, low: 100, break: 100 },
	tempDirName: ".stryker-tmp",
};

export default config;
