import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	expectNamespacedSlashOnly,
	expectNoShellComments,
	expectPlainFrontmatter,
	flagsTable,
	skillDir,
	skillText,
	usageLine,
	walk,
} from "./skill-tree-helpers";

const JOT = skillDir("jot");
const VERBS = ["add", "ls", "read", "kind", "done", "kick", "kick-list", "kick-take"];

function skill(): string {
	return skillText("jot");
}

describe("packaged jot skill tree", () => {
	test("ships SKILL.md and the checkpoint reference", () => {
		expect(existsSync(join(JOT, "SKILL.md"))).toBe(true);
		expect(existsSync(join(JOT, "references", "checkpoint.md"))).toBe(true);
	});

	test("SKILL.md is named jot and carries no host-only frontmatter keys", () => {
		expectPlainFrontmatter("jot");
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
		const usage = usageLine(text);
		expect(usage).not.toBe("");
		const table = flagsTable(text);
		expect(table).not.toBeNull();
		expect(table?.header).toEqual(["Flag", "Short", "Effect", "Default"]);
		for (const flag of ["--save", "-s", "--previous", "-p", "--kick", "-k"]) {
			expect(table?.documented.has(flag)).toBe(true);
			expect(usage).toContain(flag);
		}
		expect(text).toContain("-kp");
	});

	test("names itself with the namespaced slash form and never the bare one", () => {
		expectNamespacedSlashOnly("jot");
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

	test("shell blocks carry no hash comments", () => {
		expectNoShellComments("jot");
	});
});
