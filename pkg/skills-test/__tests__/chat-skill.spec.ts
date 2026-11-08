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

	test("the extension notes describe zero-touch pairing and never a code or a side panel", () => {
		for (const text of [skill, reference]) {
			expect(text).toContain("dg-agent start");
			expect(text).toContain("dg-skills install");
			expect(text).toContain(
				"No browser extension is connected. Install it with: dg-skills install",
			);
			expect(text).toContain(
				"Paired <identity> (<id8>) with the browser extension.",
			);
			expect(text).not.toMatch(/dg-agent pair|six-digit|pairing code|_chat=/);
			expect(text).not.toMatch(/side panel|Attach CLI session|New session for CLI/i);
		}
		expect(reference).toContain("Load unpacked");
	});

	test("the skill documents spawn with a command and the session lookup order", () => {
		expect(skill).toContain("[-- <command...>]");
		expect(skill).toContain("DG_SESSION_ID");
		expect(skill).toContain("extensionLinked");
	});
});
