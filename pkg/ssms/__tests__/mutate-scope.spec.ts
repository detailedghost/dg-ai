import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("mutation task", () => {
	test("mise pins Node 22 and Stryker covers the send path", () => {
		const mise = readFileSync(join(import.meta.dir, "..", "..", "..", ".mise", "config.toml"), "utf8");
		expect(mise).toMatch(/^node = "22"$/m);
		const stryker = readFileSync(join(import.meta.dir, "..", "stryker.conf.mjs"), "utf8");
		expect(stryker).toContain("src/cli/authorize.ts");
		expect(stryker).toContain("src/google/thread.ts");
		expect(stryker).not.toContain("src/google/page.ts");
		expect(stryker).toContain("src/safety/send-gate.ts");
	});
});