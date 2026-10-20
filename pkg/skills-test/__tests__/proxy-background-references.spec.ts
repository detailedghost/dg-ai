import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const FILES = [
	["plugins", "dg", "skills", "thrash", "references", "agent-prompt.md"],
	["plugins", "dg", "skills", "review-loop", "references", "proxy-review-prompt.md"],
	["pkg", "skills-cli", "README.md"],
];

describe("background job references use the bg command", () => {
	for (const parts of FILES) {
		const name = parts.join("/");

		test(`${name} no longer names proxy background`, () => {
			expect(readRepoFile(...parts)).not.toContain("proxy background");
		});

		test(`${name} names the bg command`, () => {
			expect(readRepoFile(...parts)).toMatch(/dg-skills bg\b/);
		});
	}
});
