import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SOURCE_SKILLS, splitFrontmatter } from "./spec-fixtures";

const JOT = join(SOURCE_SKILLS, "jot");
const VERBS = ["add", "ls", "read", "kind", "done", "kick", "kick-list", "kick-take"];
const FLAG = /(?<![\w-])(--[a-z][a-z-]*|-[A-Za-z])(?![\w-])/g;

function walk(dir: string): string[] {
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
}

function skill(): string {
	return readFileSync(join(JOT, "SKILL.md"), "utf8");
}

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

describe("packaged jot skill tree", () => {
	test("ships SKILL.md and the checkpoint reference", () => {
		expect(existsSync(join(JOT, "SKILL.md"))).toBe(true);
		expect(existsSync(join(JOT, "references", "checkpoint.md"))).toBe(true);
	});

	test("SKILL.md is named jot and carries no host-only frontmatter keys", () => {
		const { data } = splitFrontmatter(skill()) as { data: Record<string, unknown> };
		expect(data.name).toBe("jot");
		expect(String(data.description).length).toBeGreaterThan(0);
		expect(data).not.toHaveProperty("argument-hint");
		expect(data).not.toHaveProperty("user-invocable");
	});

	test("every dg-skills call uses the literal installed path and a real subcommand", () => {
		const calls = walk(JOT)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n")
			.split("\n")
			.filter((line) => line.includes("dg-skills jot"));
		expect(calls.length).toBeGreaterThan(0);
		for (const line of calls) {
			expect(line).toContain("~/.dg/bin/dg-skills jot");
			const verb = /dg-skills jot\s+([\w-]+)/.exec(line)?.[1];
			if (verb && verb !== "--help") expect(VERBS).toContain(verb);
		}
		const used = new Set(
			[...skill().matchAll(/dg-skills jot\s+([\w-]+)/g)].map((match) => match[1]),
		);
		for (const verb of VERBS) expect(used.has(verb)).toBe(true);
	});

	test("keeps the bootstrap gate before the first call", () => {
		const text = skill();
		const gate = text.indexOf("bootstrap.sh");
		expect(gate).toBeGreaterThan(-1);
		expect(text).toContain("--cli-only");
		expect(text).toContain("~/.dg/bin/dg-skills jot --help");
		expect(gate).toBeLessThan(text.indexOf("~/.dg/bin/dg-skills jot add"));
	});

	test("documents the legacy flags in a four-column Flags table and the Usage line", () => {
		const text = skill();
		const lines = text.split("\n");
		const usage = lines.find((line) => line.startsWith("**Usage:**"));
		expect(usage).toBeDefined();
		const start = lines.indexOf("## Flags");
		expect(start).toBeGreaterThan(-1);
		const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
		const rows = lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.startsWith("|"));
		expect(cells(rows[0] ?? "")).toEqual(["Flag", "Short", "Effect", "Default"]);
		const documented = new Set(
			rows.slice(2).flatMap((row) => cells(row).slice(0, 2).flatMap((cell) => [...cell.matchAll(FLAG)].map((m) => m[1]))),
		);
		for (const flag of ["--save", "-s", "--previous", "-p", "--kick", "-k"]) {
			expect(documented.has(flag)).toBe(true);
			expect(usage).toContain(flag);
		}
		expect(text).toContain("-kp");
	});

	test("names itself with the namespaced slash form and never the bare one", () => {
		const text = skill();
		expect(text).toContain("/dg:jot");
		expect(text).not.toMatch(/(?<![\w./~:$<>-])\/jot(?![\w:/-])/);
	});

	test("keeps the 2 KB cap and the checkpoint paths in the prose", () => {
		const text = skill();
		expect(text).toContain("2048");
		expect(text).toContain("checkpoint.md");
		const reference = readFileSync(join(JOT, "references", "checkpoint.md"), "utf8");
		for (const heading of ["Branches and PRs", "Done", "In progress", "Next steps", "Open questions", "Gotchas"])
			expect(reference).toContain(`### ${heading}`);
		expect(reference).toContain("--file");
		expect(reference).toContain("--replace");
	});

	test("leaves no legacy helper, private path or bare stash call behind", () => {
		for (const path of walk(JOT)) {
			const text = readFileSync(path, "utf8");
			const name = relative(JOT, path);
			expect([name, /jot-cli/.test(text)]).toEqual([name, false]);
			expect([name, /\/home\/[a-z]/.test(text)]).toEqual([name, false]);
			expect([name, /\$\(stash /.test(text)]).toEqual([name, false]);
			expect([name, /scripts\/bin/.test(text)]).toEqual([name, false]);
		}
	});
});
