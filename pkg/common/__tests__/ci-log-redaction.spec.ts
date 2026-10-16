import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "../../../.github/workflows");

describe("CI logs do not echo secrets", () => {
	const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));

	it("masks secret env values before tests, help output, or artifact upload", () => {
		for (const name of files) {
			const text = readFileSync(join(WORKFLOWS, name), "utf8");
			const runsWork =
				text.includes("bun test") ||
				text.includes('echo "$output"') ||
				text.includes("upload-artifact");
			if (!runsWork) continue;
			expect(text.includes("mask-secrets") || text.includes("::add-mask::")).toBe(
				true,
			);
		}
	});

	it("does not enable step debug, print the environment, or upload logs and traces", () => {
		for (const name of files) {
			const text = readFileSync(join(WORKFLOWS, name), "utf8");
			expect(text).not.toContain("ACTIONS_STEP_DEBUG: true");
			expect(text).not.toContain("printenv");
			expect(text).not.toContain("set -x");
			expect(text).not.toMatch(/upload-artifact[\s\S]{0,200}(screenshots|\.log|traces)/);
		}
	});
});
