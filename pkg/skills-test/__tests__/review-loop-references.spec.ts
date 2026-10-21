import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

describe("review-loop cross-skill reference", () => {
	test("SKILL.md does not link the dropped review skill", () => {
		const skill = readRepoFile("plugins", "dg", "skills", "review-loop", "SKILL.md");

		expect(skill).not.toContain("../review/");
	});
});
