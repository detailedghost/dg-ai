import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatter, REPO_ROOT } from "./test-support";

export const SKILL_CAPS = { skillBytes: 8192, descriptionChars: 400 } as const;

const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");

function descriptionOf(text: string): string {
	const match = /^description:[ \t]*(.*(?:\n(?![A-Za-z][\w-]*:).*)*)/m.exec(frontmatter(text));
	return (match?.[1] ?? "").replace(/^[>|][+-]?\s*/, "").replace(/\s*\n\s*/g, " ").trim();
}

const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => {
		const text = readFileSync(join(SKILLS_DIR, entry.name, "SKILL.md"), "utf8");
		return { name: entry.name, bytes: Buffer.byteLength(text), description: descriptionOf(text) };
	})
	.sort((a, b) => a.name.localeCompare(b.name));

describe("skill size caps", () => {
	test("finds the shipped skills", () => {
		expect(skills.length).toBeGreaterThan(50);
	});

	test(`every SKILL.md is at most ${SKILL_CAPS.skillBytes} bytes`, () => {
		const over = skills
			.filter((skill) => skill.bytes > SKILL_CAPS.skillBytes)
			.map((skill) => `${skill.name}/SKILL.md: ${skill.bytes} bytes`);
		expect(over).toEqual([]);
	});

	test(`every description is at most ${SKILL_CAPS.descriptionChars} characters`, () => {
		const over = skills
			.filter((skill) => skill.description.length > SKILL_CAPS.descriptionChars)
			.map((skill) => `${skill.name}: ${skill.description.length} characters`);
		expect(over).toEqual([]);
	});

	test("every skill has a description", () => {
		expect(skills.filter((skill) => skill.description === "").map((skill) => skill.name)).toEqual([]);
	});
});
