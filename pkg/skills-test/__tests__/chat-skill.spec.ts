import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeLocalPageSkill } from "./local-page-skill-contract";
import { REPO_ROOT } from "./test-support";

describeLocalPageSkill("chat", "dg-agent start --ext --open");

describe("chat skill extension notes", () => {
	const skillDir = join(REPO_ROOT, "plugins", "dg", "skills", "chat");
	const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
	const reference = readFileSync(
		join(skillDir, "references", "extension.md"),
		"utf8",
	);

	test("the extension notes describe popup pairing and never a side panel", () => {
		expect(reference).toMatch(/dg-agent pair/);
		expect(reference).not.toMatch(/side panel/i);
		expect(reference).not.toMatch(/Attach CLI session|New session for CLI/);
		expect(skill).not.toMatch(/side panel|Attach CLI session/i);
	});
});
