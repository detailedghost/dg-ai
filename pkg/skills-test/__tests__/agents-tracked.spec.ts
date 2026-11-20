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

function skillFiles(): { file: string; text: string }[] {
	const skills = join(REPO_ROOT, "plugins", "dg", "skills");
	return [...new Bun.Glob("**/*.md").scanSync(skills)].map((file) => ({
		file,
		text: readRepoFile("plugins", "dg", "skills", file),
	}));
}

function seedIgnoreBlock(): string[] {
	const templates = readRepoFile("plugins", "dg", "skills", "agent-seed", "references", "templates.md");
	const section = templates.split("## .gitignore Entry")[1]?.split("\n## ")[0] ?? "";
	const fence = /```\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
	return fence.split("\n").filter((line) => line.trim() !== "");
}

describe(".agents is tracked agent memory", () => {
	test("the agent-seed .gitignore template lists exactly the scratch set", () => {
		expect(seedIgnoreBlock()).toEqual(SCRATCH);
	});

	test("no skill force-adds an .agents path", () => {
		const hits = skillFiles()
			.flatMap(({ file, text }) => text.split("\n").map((line) => ({ file, line })))
			.filter(({ line }) => /git add (?:-f|--force)\b[^\n]*\.agents/.test(line));
		expect(hits).toEqual([]);
	});

	test("no skill calls .agents/ gitignored by default", () => {
		const hits = skillFiles().flatMap(({ file, text }) =>
			IGNORED_BY_DEFAULT.filter((pattern) => pattern.test(text)).map((pattern) => ({ file, pattern: pattern.source })),
		);
		expect(hits).toEqual([]);
	});

	test("agent-seed and spring-break migrate an old .agents ignore block to the scratch list", () => {
		const seed = readRepoFile("plugins", "dg", "skills", "agent-seed", "references", "workflow.md");
		const spring = readRepoFile("plugins", "dg", "skills", "spring-break", "SKILL.md");
		for (const text of [seed, spring]) {
			expect(text).toContain("`.agents/*`");
			expect(text).toMatch(/[Rr]eplace[^\n]*scratch list/);
		}
	});

	test("a refused bundle add points at the migration, never at -f", () => {
		const spec = readRepoFile("plugins", "dg", "skills", "spec", "SKILL.md");
		expect(spec).toMatch(/refuses[^\n]*\n?[^\n]*`\/dg:spring-break`/);
		expect(spec).toContain("never `-f`");
	});
});
