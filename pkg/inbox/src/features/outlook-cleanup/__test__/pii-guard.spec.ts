import { describe, expect, test } from "bun:test";

const scannedGlobs = [
	"src/**/*.ts",
	"test/**/*.ts",
	"README.md",
	"organizer.config.example.json",
];

const forbiddenPiiMarkers = [
	["burgosdante", "gmail.com"].join("@"),
	["detailedghost", "gmail.com"].join("@"),
	["detailedghost", "proton.me"].join("@"),
];

describe("outlook cleanup PII guardrails", () => {
	test("source, tests, README, and config examples do not contain known raw mailbox identifiers", async () => {
		const violations: string[] = [];
		for (const pattern of scannedGlobs) {
			const glob = new Bun.Glob(pattern);
			for await (const path of glob.scan(".")) {
				const text = await Bun.file(path).text();
				for (const marker of forbiddenPiiMarkers) {
					if (text.includes(marker)) {
						violations.push(`${path}: ${marker}`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("production cleanup code does not contain account-specific mailbox policy literals", async () => {
		const forbiddenPolicyMarkers = [
			["Clock", "ify"].join(""),
			["Far", "well"].join(""),
			["Fare", "well"].join(""),
			["company", "internal"].join("."),
			["microsoft", "com"].join("."),
			["security", "review"].join("-"),
			["ambiguous", "review"].join("-"),
		];
		const violations: string[] = [];
		const glob = new Bun.Glob("src/features/outlook-cleanup/**/*.ts");
		for await (const path of glob.scan(".")) {
			if (path.includes("/__test__/")) {
				continue;
			}
			const text = await Bun.file(path).text();
			for (const marker of forbiddenPolicyMarkers) {
				if (text.includes(marker)) {
					violations.push(`${path}: ${marker}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
