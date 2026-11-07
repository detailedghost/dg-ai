import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeLocalPageSkill } from "./local-page-skill-contract";
import { REPO_ROOT } from "./test-support";

describeLocalPageSkill("overwatch", "dg-agent overwatch open --ext");

describe("overwatch skill extension notes", () => {
	const skillDir = join(REPO_ROOT, "plugins", "dg", "skills", "overwatch");
	const texts = [
		readFileSync(join(skillDir, "SKILL.md"), "utf8"),
		readFileSync(join(skillDir, "references", "extension.md"), "utf8"),
	];

	test("never mentions a side panel", () => {
		for (const text of texts) expect(text).not.toMatch(/side panel/i);
	});

	test("says --ext opens /board in the paired browser", () => {
		expect(texts.join("\n")).toMatch(/\/board/);
		expect(texts.join("\n")).toMatch(/paired browser/i);
	});
});
