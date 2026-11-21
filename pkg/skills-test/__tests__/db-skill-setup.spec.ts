import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const skillDir = join(REPO_ROOT, "plugins", "dg", "skills", "db");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const connections = readFileSync(
	join(skillDir, "references", "connections.md"),
	"utf8",
);

describe("db skill setup flow", () => {
	test("SKILL.md runs dg db setup and names the three secret modes", () => {
		expect(skill).toContain("dg db setup");
		for (const mode of ["--secret aws", "--secret form", "--secret command"]) {
			expect(skill).toContain(mode);
		}
	});

	test("SKILL.md asks the human with AskUserQuestion after db connections", () => {
		expect(skill).toContain("AskUserQuestion");
		expect(skill).toContain("dg db connections");
	});

	test("SKILL.md never asks for a password in chat", () => {
		expect(skill).toMatch(/never ask for[^.]*(password|secret)[^.]*chat/i);
	});

	test("SKILL.md tells the human to run the command mode line in their own terminal", () => {
		expect(skill).toContain("own terminal");
		expect(skill).not.toMatch(/^!\s*dg-skills/m);
	});

	test("SKILL.md points a failing step at doctor credentials db", () => {
		expect(skill).toContain("dg doctor credentials db");
	});

	test("connections.md lists the setup meta keys", () => {
		for (const key of [
			"readOnly",
			"secretSource",
			"secretId",
			"secretKey",
			"awsProfile",
			"awsRegion",
		]) {
			expect(connections).toContain(key);
		}
	});

	test("connections.md documents setup before the raw credentials recipes", () => {
		const setup = connections.indexOf("dg db setup");
		const raw = connections.indexOf("dg credentials set");
		expect(setup).toBeGreaterThan(-1);
		expect(setup).toBeLessThan(raw);
	});
});
