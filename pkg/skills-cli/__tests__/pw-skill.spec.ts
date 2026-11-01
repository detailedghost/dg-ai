import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter } from "./spec-fixtures";
import {
	expectNamespacedSlashOnly,
	expectNoShellComments,
	expectPlainFrontmatter,
	firstCallIndex,
	skillDir,
	skillText,
	treeFiles,
} from "./skill-tree-helpers";

const NAME = "pw";
const MAX_LINES = 90;
const REFERENCES = [
	"commands.md",
	"request-mocking.md",
	"running-code.md",
	"session-management.md",
	"storage-state.md",
	"test-generation.md",
	"tracing.md",
	"video-recording.md",
	"windows.md",
];
const DOCTOR_LINE = /^If a step fails, run ~\/\.dg\/bin\/dg-skills doctor ([a-z][a-z -]*)\.?$/m;

function sentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.filter(Boolean);
}

describe("packaged pw skill tree", () => {
	test("ships SKILL.md with plain frontmatter named pw", () => {
		expect(existsSync(join(skillDir(NAME), "SKILL.md"))).toBe(true);
		expectPlainFrontmatter(NAME);
	});

	test("keeps SKILL.md within the line budget", () => {
		expect(skillText(NAME).trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_LINES);
	});

	test("ships every reference file with content", () => {
		for (const file of REFERENCES) {
			const path = join(skillDir(NAME), "references", file);
			expect([file, existsSync(path)]).toEqual([file, true]);
			expect([file, readFileSync(path, "utf8").trim().length > 0]).toEqual([file, true]);
		}
	});

	test("names install-browser and tells the agent to ask the human before running it", () => {
		const text = skillText(NAME);
		expect(text).toContain("dg-skills pw install-browser");
		const asking = sentences(text).filter(
			(sentence) => sentence.includes("install-browser") && /\bask\b/i.test(sentence),
		);
		expect(asking.length).toBeGreaterThan(0);
	});

	test("carries the WSL rule and the --wsl-headed prohibition sentence", () => {
		const text = skillText(NAME);
		expect(text).toMatch(/\bWSL\b/);
		expect(text).toContain("--wsl-headed");
		const prohibition = sentences(text).filter(
			(sentence) =>
				/agents? never pass(es)? `?--wsl-headed`?/i.test(sentence) &&
				/unless the human asks/i.test(sentence),
		);
		expect(prohibition.length).toBeGreaterThan(0);
	});

	test("forbids launching a headed browser on WSL", () => {
		const forbidding = sentences(skillText(NAME)).filter(
			(sentence) => /never/i.test(sentence) && /headed/i.test(sentence) && /WSL/.test(sentence),
		);
		expect(forbidding.length).toBeGreaterThan(0);
	});

	test("never lists pw-code in allowed-tools", () => {
		const { data } = splitFrontmatter(skillText(NAME)) as { data: Record<string, unknown> };
		const allowed = data["allowed-tools"];
		const rendered = Array.isArray(allowed) ? allowed.join(" ") : String(allowed ?? "");
		expect(rendered).not.toContain("pw-code");
	});

	test("never grants pw-code through a wildcard allow rule in the tree", () => {
		for (const { file, text } of treeFiles(NAME))
			for (const line of text.split("\n").filter((l) => /allowed-tools|Bash\(/.test(l)))
				expect([file, line.includes("pw-code:*")]).toEqual([file, false]);
	});

	test("states the security rule for pw-code", () => {
		const text = skillText(NAME);
		expect(text).toContain("pw-code");
		const rule = sentences(text).filter(
			(sentence) => sentence.includes("pw-code") && /ask|approve|never|confirm|prompt/i.test(sentence),
		);
		expect(rule.length).toBeGreaterThan(0);
	});

	test("keeps the bootstrap gate before the first dg-skills call", () => {
		const text = skillText(NAME);
		expect(text).toContain("--cli-only");
		const { gate, call } = firstCallIndex(text);
		expect(gate).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(gate);
	});

	test("calls dg-skills pw from SKILL.md only through the literal installed path", () => {
		const calls = skillText(NAME)
			.split("\n")
			.filter((line) => /dg-skills pw(?!-code)\s+[a-z]/.test(line) && !line.includes("`dg-skills pw"));
		expect(calls.length).toBeGreaterThan(0);
		for (const line of calls) expect(line).toContain("~/.dg/bin/dg-skills");
	});

	test("names pw and pw-code on the doctor line", () => {
		const items = (DOCTOR_LINE.exec(skillText(NAME))?.[1] ?? "").trim().split(/\s+/);
		expect(items).toContain("pw");
		expect(items).toContain("pw-code");
	});

	test("carries no references to the pre-port ~/scripts or ~/.codex locations", () => {
		for (const { file, text } of treeFiles(NAME)) {
			expect([file, text.includes("~/.codex")]).toEqual([file, false]);
			expect([file, text.includes("~/scripts")]).toEqual([file, false]);
		}
	});

	test("uses the namespaced slash form only and no shell comments", () => {
		expectNamespacedSlashOnly(NAME);
		expectNoShellComments(NAME);
	});
});
