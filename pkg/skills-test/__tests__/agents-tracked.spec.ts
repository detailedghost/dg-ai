import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const SCRATCH = [
	".agents/verify/",
	".agents/code-review/",
	".agents/jot/",
	".agents/clipboard/",
	".agents/spec/**/roundtable/",
];

const IGNORED_BY_DEFAULT = [
	/agent-seed`? ignores `?\.agents/,
	/`\.agents\/` is (?:local|ignored|gitignored)/,
	/[Aa]dd `\.agents\/` to `\.gitignore`/,
	/`\.agents\/`[^.\n]*gitignored by default/,
	/`\.agents\/` is ignored/,
	/`\.agents\/prototype\/` is gitignored/,
];

const FORCED_AGENTS_ADD = /\bgit add\b[^&;|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/;

const SKILLS = ["plugins", "dg", "skills"];

function readSkill(...parts: string[]): string {
	return readRepoFile(...SKILLS, ...parts);
}

function skillDocs(): { file: string; text: string }[] {
	return [...new Bun.Glob("**/*.md").scanSync(join(REPO_ROOT, ...SKILLS))].map((file) => ({
		file,
		text: readSkill(file),
	}));
}

function seedIgnoreBlock(): string[] {
	const section = readSkill("agent-seed", "references", "templates.md").split("## .gitignore Entry")[1];
	if (section === undefined) throw new Error("templates.md has no '## .gitignore Entry' section");
	const fence = /```\n([\s\S]*?)```/.exec(section.split("\n## ")[0] ?? "")?.[1];
	if (fence === undefined) throw new Error("the .gitignore Entry section has no plain fenced block");
	return fence.split("\n").filter((line) => line.trim() !== "");
}

describe(".agents is tracked agent memory", () => {
	test("the agent-seed .gitignore template lists exactly the scratch set", () => {
		expect(seedIgnoreBlock()).toEqual(SCRATCH);
	});

	test("no skill doc force-adds an .agents path", () => {
		const hits = skillDocs()
			.flatMap(({ file, text }) => text.split("\n").map((line) => ({ file, line })))
			.filter(({ line }) => /\.agents/.test(line) && FORCED_AGENTS_ADD.test(line));
		expect(hits).toEqual([]);
	});

	test.each(["git add -f .agents/x", "git add .agents/x -f", "git add -A --force .agents", "git add -fv .agents"])(
		"the force-add guard catches %s",
		(line) => {
			expect(FORCED_AGENTS_ADD.test(line)).toBe(true);
		},
	);

	test.each(["git add .agents/spec/x/ && git commit -m fix", "git add .agents/x && git push --force"])(
		"the force-add guard allows %s",
		(line) => {
			expect(FORCED_AGENTS_ADD.test(line)).toBe(false);
		},
	);

	test("no skill doc calls .agents/ gitignored by default", () => {
		const hits = skillDocs().flatMap(({ file, text }) =>
			IGNORED_BY_DEFAULT.filter((pattern) => pattern.test(text)).map((pattern) => ({ file, pattern: pattern.source })),
		);
		expect(hits).toEqual([]);
	});

	test.each(["agent-seed/references/workflow.md", "spring-break/SKILL.md"])(
		"%s migrates an old .agents ignore block to the scratch list",
		(file) => {
			const text = readSkill(...file.split("/"));
			expect(text).toContain("`.agents/*`");
			expect(text).toMatch(/[Rr]eplace[^\n]*scratch list/);
		},
	);

	test("a refused bundle add points at the migration, never at -f", () => {
		const spec = readSkill("spec", "SKILL.md");
		expect(spec).toMatch(/refuses[^\n]*\n?[^\n]*`\/dg:spring-break`/);
		expect(spec).toMatch(/never `-f`/i);
	});
});
