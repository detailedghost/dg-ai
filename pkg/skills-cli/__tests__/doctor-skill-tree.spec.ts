import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	bareSlash,
	fences,
	firstCallIndex,
	flagsTable,
	FLAG,
	hasShellComment,
	SHELL_LANGS,
	skillDir,
	skillText,
	treeFiles,
	usageLine,
} from "./skill-tree-helpers";
import { splitFrontmatter } from "./spec-fixtures";

const NAME = "doctor";

describe("packaged doctor skill tree", () => {
	test("ships SKILL.md", () => {
		expect(existsSync(join(skillDir(NAME), "SKILL.md"))).toBe(true);
	});

	test("is named doctor and carries no host-only frontmatter keys", () => {
		const { data } = splitFrontmatter(skillText(NAME)) as {
			data: Record<string, unknown>;
		};
		expect(data.name).toBe(NAME);
		expect(String(data.description).length).toBeGreaterThan(0);
		expect(data).not.toHaveProperty("argument-hint");
		expect(data).not.toHaveProperty("user-invocable");
	});

	test("names itself with the namespaced slash form and never the bare one", () => {
		const text = skillText(NAME);
		expect(text).toContain("/dg:doctor");
		expect(text).not.toMatch(bareSlash(NAME));
	});

	test("carries a Usage line and a four-column Flags table covering its flags", () => {
		const text = skillText(NAME);
		const usage = usageLine(text);
		expect(usage).toContain("/dg:doctor");
		expect(usage).toContain("[<item>...]");
		const table = flagsTable(text);
		expect(table).not.toBeNull();
		expect(table?.header).toEqual(["Flag", "Short", "Effect", "Default"]);
		for (const flag of [...usage.matchAll(FLAG)].map((match) => match[1]))
			expect(table?.documented.has(flag)).toBe(true);
	});

	test("probes doctor --help in the bootstrap gate before the first call", () => {
		const text = skillText(NAME);
		expect(text).toContain("~/.dg/bin/dg-skills doctor --help");
		expect(text).toContain("bootstrap.sh");
		expect(text).toContain("--cli-only");
		const { gate, call } = firstCallIndex(text);
		expect(gate).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(gate);
	});

	test("runs doctor with --json through the literal installed path", () => {
		const text = skillText(NAME);
		expect(text).toContain("~/.dg/bin/dg-skills doctor --json");
		for (const { file, text: body } of treeFiles(NAME))
			for (const line of body.split("\n").filter((l) => l.includes("dg-skills")))
				expect([file, line.includes("~/.dg/bin/dg-skills") || line.includes("bootstrap.sh")]).toEqual([file, true]);
	});

	test("asks before running any Fix command and explains failures in plain words", () => {
		const text = skillText(NAME).toLowerCase();
		expect(text).toContain("fix");
		expect(text).toMatch(/ask[^.\n]*before[^.\n]*run/);
		expect(text).toMatch(/one (by one|at a time)/);
	});

	test("shell blocks carry no hash comments", () => {
		for (const { file, text } of treeFiles(NAME))
			for (const { lang, body } of fences(text))
				if (SHELL_LANGS.includes(lang))
					for (const line of body.split("\n"))
						expect([file, line, hasShellComment(line)]).toEqual([file, line, false]);
	});

	test("leaves no private path or local zone behind", () => {
		for (const { file, text } of treeFiles(NAME)) {
			expect([file, /\/home\/[a-z]/.test(text)]).toEqual([file, false]);
			expect([file, /~\/\.claude\/skills\//.test(text)]).toEqual([file, false]);
			expect([file, /scripts\/bin/.test(text)]).toEqual([file, false]);
		}
	});
});
