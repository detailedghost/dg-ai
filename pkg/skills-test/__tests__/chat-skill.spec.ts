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

	test("the side panel attach notes moved into references/extension.md", () => {
		expect(reference).toMatch(/side panel/i);
		expect(reference).toMatch(/Attach CLI session/);
		expect(skill).not.toMatch(/Attach CLI session/);
	});
});
