import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	bareSlash,
	cells,
	codeSpans,
	FLAG,
	fences,
	firstCallIndex,
	flagsTable,
	hasShellComment,
	SHELL_LANGS,
	skillDir,
	skillText,
	treeFiles,
	treeText,
	usageLine,
} from "./skill-tree-helpers";
import { SOURCE_SKILLS, splitFrontmatter } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const SCANNED = ["sniff", "nope", "find-work"];
const BOOTSTRAP_URL =
	/https:\/\/github\.com\/detailedghost\/dg-ai\/releases\/latest\/download\/bootstrap\.sh/g;

function verbsOf(command: string): string[] {
	const run = Bun.spawnSync([process.execPath, ENTRY, command, "--help"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return [...run.stdout.toString().matchAll(/^ {2}([a-z][\w-]*)(?: |$)/gm)].map(
		(match) => match[1] ?? "",
	);
}

function verbsCalled(text: string, command: string): string[] {
	return [
		...text.matchAll(new RegExp(`dg-skills ${command}\\s+([\\w-]+)`, "g")),
	].map((match) => match[1] ?? "");
}

function checkedText(line: string): string {
	if (line.startsWith("|")) return cells(line).at(-1) ?? "";
	return /agentType/.test(line) ? line : "";
}

function homeReferences(text: string): string[] {
	return [...text.matchAll(/(?:~|\$HOME|\$\{HOME\})\/[^\s`'")>\]]*/g)].map(
		(match) => match[0],
	);
}

describe.each(SCANNED)("packaged %s skill tree", (name) => {
	test("is named for the skill and carries no host-only frontmatter keys", () => {
		const { data } = splitFrontmatter(skillText(name)) as {
			data: Record<string, unknown>;
		};
		expect(data.name).toBe(name);
		expect(String(data.description).length).toBeGreaterThan(0);
		expect(data).not.toHaveProperty("argument-hint");
		expect(data).not.toHaveProperty("user-invocable");
	});

	test("names itself with the namespaced slash form and never the bare one", () => {
		const text = skillText(name);
		expect(text).toContain(`/dg:${name}`);
		for (const { file, text: body } of treeFiles(name))
			expect([file, bareSlash(name).test(body)]).toEqual([file, false]);
	});

	test("carries no private name, host, email, home path or legacy helper", () => {
		for (const { file, text: raw } of treeFiles(name)) {
			const text = raw.replace(BOOTSTRAP_URL, "");
			for (const pattern of [
				/\/home\/(?!user\b)[a-z]/,
				/\/Users\/(?!user\b)[A-Za-z]/,
				/detailedghost/i,
				/jasper/i,
				/core-entity-api|entity[-_]mgmt|backstop|okta|wiz\.io/i,
				/JRDEV/,
				/@(?!example\.)[\w-]+\.(?:com|io|net|org|dev)\b/,
				/\b[\w-]+\.(?:internal|corp|lan)\b/,
				/scripts\/(?:bin|ai)/,
				/~\/\.claude\/skills/,
				/\.agents\/decisions/,
				/\$\(stash /,
				/\b(?:sniff|jot|bg|worktree|vcs-provider|chain|stash)-cli\b/,
			])
				expect([file, pattern.test(text)]).toEqual([file, false]);
		}
	});

	test("every dg-skills call uses the literal installed path", () => {
		for (const { file, text } of treeFiles(name))
			for (const line of text.split("\n"))
				if (/dg-skills\s+[a-z]/.test(line))
					expect([file, line, line.includes("~/.dg/bin/dg-skills")]).toEqual([
						file,
						line,
						true,
					]);
	});

	test("uses no hash comments inside shell blocks", () => {
		for (const { file, text } of treeFiles(name))
			for (const { lang, body } of fences(text))
				if (SHELL_LANGS.includes(lang))
					for (const line of body.split("\n"))
						expect([file, line, hasShellComment(line)]).toEqual([
							file,
							line,
							false,
						]);
	});

});

describe("packaged skill flags", () => {
	test("sniff documents flags in a four-column table matching its Usage line", () => {
		const text = skillText("sniff");
		const usage = usageLine(text);
		expect(usage).not.toBe("");
		const table = flagsTable(text);
		expect(table).not.toBeNull();
		expect(table?.header).toEqual(["Flag", "Short", "Effect", "Default"]);
		for (const match of usage.matchAll(FLAG))
			expect([match[1], table?.documented.has(match[1] ?? "")]).toEqual([
				match[1],
				true,
			]);
	});

	test.each(["find-work", "nope"])(
		"%s takes no flags, so it has no flag in Usage and no Flags table",
		(name) => {
			const text = skillText(name);
			expect([...usageLine(text).matchAll(FLAG)]).toEqual([]);
			expect(flagsTable(text)).toBeNull();
		},
	);
});

describe("packaged sniff skill", () => {
	test("ships SKILL.md and the detection reference", () => {
		for (const file of ["SKILL.md", "references/detection.md"])
			expect(existsSync(join(skillDir("sniff"), file))).toBe(true);
	});

	test("probes sniff --help in the bootstrap gate before the first real call", () => {
		const text = skillText("sniff");
		expect(text).toContain("--cli-only");
		expect(text).toContain("~/.dg/bin/dg-skills sniff --help");
		const { gate, call } = firstCallIndex(text);
		expect(gate).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(gate);
	});

	test("runs the inventory through the installed CLI with a path argument", () => {
		const text = treeText("sniff");
		expect(text).toMatch(/~\/\.dg\/bin\/dg-skills sniff (?!--help)\S/);
		for (const span of codeSpans(text))
			expect([span, /^sniff(\s|$)/.test(span)]).toEqual([span, false]);
	});

	test("documents the gaps and output-file flags with the Usage line", () => {
		const text = skillText("sniff");
		const table = flagsTable(text);
		for (const flag of ["--gaps", "-o"]) {
			expect(table?.documented.has(flag)).toBe(true);
			expect(usageLine(text)).toContain(flag);
		}
	});

	test("writes its output file through the packaged stash, not a bare helper", () => {
		const text = treeText("sniff");
		expect(text).toContain("~/.dg/bin/dg-skills stash");
	});

	test("never routes a render through the viz skill, which no longer ships", () => {
		for (const { file, text } of treeFiles("sniff"))
			expect([file, /\/viz\b|skills\/viz/.test(text)]).toEqual([file, false]);
	});

	test("keeps the names-only rule and the report-do-not-grade rule", () => {
		const text = skillText("sniff");
		expect(text).toMatch(
			/never print a value for a `?SECRET`? or `?CONFIG`? row/i,
		);
		for (const type of [
			"SECRET",
			"CONFIG",
			"CLOUD_PERM",
			"SERVICE",
			"NETWORK",
			"TOOLCHAIN",
			"REGISTRY",
		])
			expect(text).toContain(type);
	});

	test("keeps the four gap kinds and the detection reference coverage", () => {
		const text = skillText("sniff");
		for (const kind of ["undeclared", "undocumented", "unused", "drifted"])
			expect(text).toContain(kind);
		const reference = readFileSync(
			join(skillDir("sniff"), "references", "detection.md"),
			"utf8",
		);
		for (const needle of [
			"process.env",
			"os.getenv",
			"Environment.GetEnvironmentVariable",
			"proven: false",
		])
			expect(reference).toContain(needle);
		expect(reference).toContain("~/.dg/bin/dg-skills sniff");
	});
});

describe("packaged nope skill", () => {
	test("ships a single SKILL.md", () => {
		expect(treeFiles("nope").map(({ file }) => file)).toEqual(["SKILL.md"]);
	});

	test("keeps the tool order from LSP down to the built-in search", () => {
		const text = skillText("nope");
		const positions = ["LSP", "fff", "ripgrep", "Built-in"].map((needle) =>
			text.indexOf(needle),
		);
		for (const position of positions) expect(position).toBeGreaterThan(-1);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		for (const tool of [
			"mcp__fff__grep",
			"mcp__fff__multi_grep",
			"mcp__fff__find_files",
		])
			expect(text).toContain(tool);
	});

	test("keeps the learning record, its dedupe rule and the five-entry bound", () => {
		const text = skillText("nope");
		expect(text).toContain("## Tool Defaults");
		expect(text).toMatch(/increment/i);
		expect(text).toContain("/dg:nope invoked");
	});

	test("describes the memory directory in words with no home path", () => {
		const text = treeText("nope");
		expect(text).toContain("MEMORY.md");
		expect(homeReferences(text)).toEqual([]);
		expect(text).not.toMatch(/\/home\//);
	});

	test("needs no CLI, so it makes no dg-skills call", () => {
		expect(treeText("nope")).not.toContain("dg-skills");
	});
});

describe("packaged find-work skill", () => {
	const FILES = [
		"SKILL.md",
		"references/phases.md",
		"references/discovery-prompts.md",
		"references/execution-template.md",
		"references/discover.workflow.mjs",
		"references/execute.workflow.mjs",
	];
	let providerVerbs: string[] = [];
	let worktreeVerbs: string[] = [];
	beforeAll(() => {
		providerVerbs = verbsOf("vcs-provider");
		worktreeVerbs = verbsOf("worktree");
	});
	const phases = () =>
		readFileSync(join(skillDir("find-work"), "references/phases.md"), "utf8");
	const template = () =>
		readFileSync(
			join(skillDir("find-work"), "references/execution-template.md"),
			"utf8",
		);

	test("ships the complete tree including both workflow scripts", () => {
		for (const file of FILES)
			expect(existsSync(join(skillDir("find-work"), file))).toBe(true);
		for (const file of FILES.filter((value) => value.endsWith(".mjs")))
			expect(readFileSync(join(skillDir("find-work"), file), "utf8")).toContain(
				"export const meta",
			);
		expect(
			readdirSync(join(skillDir("find-work"), "references")).sort(),
		).toEqual(
			FILES.filter((value) => value.startsWith("references/"))
				.map((value) => value.slice("references/".length))
				.sort(),
		);
	});

	test("probes the provider and worktree commands in the bootstrap gate", () => {
		const text = skillText("find-work");
		expect(text).toContain("--cli-only");
		expect(text).toContain("~/.dg/bin/dg-skills vcs-provider --help");
		expect(text).toContain("~/.dg/bin/dg-skills worktree --help");
		const { gate, call } = firstCallIndex(text);
		expect(gate).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(gate);
	});

	test("routes every provider operation through dg-skills vcs-provider", () => {
		const text = treeText("find-work");
		expect(providerVerbs.length).toBeGreaterThan(0);
		const used = new Set(verbsCalled(text, "vcs-provider"));
		for (const verb of [
			"detect",
			"auth",
			"list-issues",
			"list-prs",
			"list-threads",
			"view-issue",
			"view-pr",
			"create-pr",
		])
			expect([verb, used.has(verb)]).toEqual([verb, true]);
		for (const verb of used)
			expect([verb, [...providerVerbs, "--help"].includes(verb)]).toEqual([
				verb,
				true,
			]);
		expect(text).not.toMatch(/vcs-provider-cli/);
		expect(text).not.toMatch(/\b(?:gh pr create|glab mr create)\b/);
	});

	test("creates and removes worktrees only through dg-skills worktree", () => {
		const text = treeText("find-work");
		expect(worktreeVerbs.length).toBeGreaterThan(0);
		const used = new Set(verbsCalled(text, "worktree"));
		expect(used.has("create")).toBe(true);
		for (const verb of used)
			expect([verb, [...worktreeVerbs, "--help"].includes(verb)]).toEqual([
				verb,
				true,
			]);
		expect(text).not.toMatch(/git[^\n]*\bworktree (?:add|remove)\b/);
		expect(text).not.toMatch(/worktree-cli/);
	});

	test("names sibling skills with /dg: and agents with dg:", () => {
		const text = treeText("find-work");
		expect(text).toContain("/dg:chain");
		const names = readdirSync(SOURCE_SKILLS).filter(
			(entry) => entry !== "find-work",
		);
		for (const sibling of names)
			expect([sibling, bareSlash(sibling).test(text)]).toEqual([
				sibling,
				false,
			]);
		expect(text).toContain("dg:reviewer");
		for (const line of text.split("\n"))
			expect([line, /(?<!dg:)\breviewer\b/.test(checkedText(line))]).toEqual([
				line,
				false,
			]);
	});

	test("keeps the human selection gate before any worktree is created", () => {
		const text = phases();
		const select = text.indexOf("## Phase 2");
		const execute = text.indexOf("## Phase 3 ");
		expect(select).toBeGreaterThan(-1);
		expect(execute).toBeGreaterThan(select);
		const section = text.slice(select, execute);
		expect(section).toContain("AskUserQuestion");
		expect(section).toContain("multiSelect: true");
		expect(section).toMatch(/At least 1 item selected/);
		expect(section).not.toContain("dg-skills worktree create");
		expect(text.indexOf("dg-skills worktree create")).toBeGreaterThan(execute);
		expect(skillText("find-work")).toMatch(/Max 4 selectable/);
	});

	test("keeps the unconditional human review gate before any PR is opened", () => {
		const text = phases();
		const gate = text.indexOf("## Phase 3.5");
		const report = text.indexOf("## Phase 4");
		expect(gate).toBeGreaterThan(-1);
		expect(report).toBeGreaterThan(gate);
		const section = text.slice(gate, report);
		expect(section).toMatch(/unconditional/i);
		expect(section).toContain("AskUserQuestion");
		for (const option of ["Open all", "Choose", "Hold"])
			expect(section).toContain(option);
		expect(section).toMatch(/multiSelect: true/);
		expect(section).toContain("create-pr --draft");
		const firstCreate = text.search(/dg-skills vcs-provider create-pr/);
		expect(firstCreate).toBeGreaterThan(gate);
		expect(skillText("find-work")).toMatch(/NEVER skip a gate/);
	});

	test("lets no discovery prompt, workflow script or worktree agent open a PR", () => {
		for (const { file, text } of treeFiles("find-work")) {
			if (file === "SKILL.md" || file === "references/phases.md") continue;
			for (const line of text.split("\n"))
				if (/create-pr/.test(line))
					expect([file, line, /do not|never|not run/i.test(line)]).toEqual([
						file,
						line,
						true,
					]);
		}
		expect(template()).toMatch(/DO NOT create the PR/);
		expect(template()).toContain("pr_body_draft");
		expect(template()).toContain("Generated by /dg:find-work");
	});

	test("hands dependent approved items to chain only after the same approval", () => {
		const text = phases();
		const gate = text.indexOf("## Phase 3.5");
		expect(text.indexOf("dg-skills chain plan")).toBeGreaterThan(gate);
		expect(text.indexOf("dg-skills chain apply")).toBeGreaterThan(
			text.indexOf("dg-skills chain plan"),
		);
	});

	test("probes every subcommand it calls in the bootstrap gate", () => {
		const text = skillText("find-work");
		for (const sub of ["vcs-provider", "worktree", "chain"])
			expect(text).toContain(`~/.dg/bin/dg-skills ${sub} --help`);
	});

	test("documents the same workflow return and scanner fields the scripts use", () => {
		const text = phases();
		expect(text).not.toContain("pr_url");
		expect(text).toContain("pr_body_draft");
		const prompts = treeText("find-work");
		for (const field of ['"kind"', '"ageDays"'])
			expect(prompts).toContain(field);
	});

	test("uses only the portable HOME/code default and no other home path", () => {
		const text = treeText("find-work");
		expect(text).not.toContain("PRECREATE");
		for (const reference of homeReferences(text))
			expect([
				reference,
				/^(?:~\/\.dg\/bin\/dg-skills|\$HOME\/code|~\/code)/.test(reference),
			]).toEqual([reference, true]);
	});

	test("keeps the planning limits and the conventional commit instruction", () => {
		const text = skillText("find-work");
		expect(text).toMatch(/Conventional commits/);
		expect(text).toContain('model: "haiku"');
		expect(text).toContain('model: "sonnet"');
	});
});
