import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { makeTempDir } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";

export const FIXED_DATE = "2026-01-15";
export const FIXED_STAMP = "20260115-093045";

export type GitStep = string[];

export interface SpecCase {
	id: string;
	args: string[];
	files?: Record<string, string>;
	git?: GitStep[];
	stdin?: string;
	env?: Record<string, string>;
	semanticFrontmatter?: boolean;
	stderrContains?: string[];
}

export interface SpecOutcome {
	status: number;
	stdout: string;
	stderr: string;
	tree: Record<string, string>;
}

export interface SpecGolden extends SpecCase {
	expect: SpecOutcome;
}

export interface SpecContext {
	base: string;
	root: string;
	home: string;
	scratch: string;
	state: string;
	bin: string;
}

export interface SpecRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type SpecRunner = (
	args: string[],
	options: { cwd: string; env: Record<string, string>; stdin?: string },
) => Promise<SpecRun>;

const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture Author",
	GIT_AUTHOR_EMAIL: "author@example.invalid",
	GIT_COMMITTER_NAME: "Fixture Author",
	GIT_COMMITTER_EMAIL: "author@example.invalid",
	GIT_AUTHOR_DATE: "2026-01-15T09:30:45Z",
	GIT_COMMITTER_DATE: "2026-01-15T09:30:45Z",
};

export function runFixtureGit(args: string[], cwd: string): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		env: mergeEnv({ ...GIT_ENV, GIT_DIR: undefined, GIT_WORK_TREE: undefined }),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

export function newSpecContext(): SpecContext {
	const base = makeTempDir("dg-spec-");
	const context = {
		base,
		root: join(base, "work tree"),
		home: join(base, "home"),
		scratch: join(base, "scratch"),
		state: join(base, "state"),
		bin: join(base, "bin"),
	};
	for (const dir of Object.values(context)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(context.bin, "claude"),
		`#!/bin/sh\nprintf 'reviewed by %s\\n' "$3"\n`,
	);
	chmodSync(join(context.bin, "claude"), 0o755);
	return context;
}

export function disposeSpecContext(context: SpecContext): void {
	rmSync(context.base, { recursive: true, force: true });
}

export function baseEnv(context: SpecContext): Record<string, string> {
	return mergeEnv({
		HOME: context.home,
		AI_SCRATCH_DIR: context.scratch,
		AI_STATE_DIR: context.state,
		XDG_STATE_HOME: undefined,
		LC_ALL: "C",
		LANG: "C",
		TZ: "UTC",
		NO_COLOR: "1",
		PATH: `${context.bin}:${process.env.PATH ?? ""}`,
		AGENTS_DIR: undefined,
		CODEX_HOME: undefined,
		DG_HOME: undefined,
		DG_SKILLS: undefined,
		DG_SKILLS_DIR: undefined,
		DG_SKILLS_DEST: undefined,
		DG_PLUGIN_ROOT: undefined,
		CLAUDE_PLUGIN_ROOT: undefined,
		CODEX_PLUGIN_ROOT: undefined,
		SPEC_SCHEMA_DIR: undefined,
		DG_TEST_NOW: undefined,
		...GIT_ENV,
	});
}

export function expandPlaceholders(text: string, context: SpecContext): string {
	return text
		.replaceAll("{root}", context.root)
		.replaceAll("{scratch}", context.scratch)
		.replaceAll("{state}", context.state)
		.replaceAll("{home}", context.home);
}

export function collapsePlaceholders(
	text: string,
	context: SpecContext,
): string {
	return text
		.replaceAll(context.root, "{root}")
		.replaceAll(context.scratch, "{scratch}")
		.replaceAll(context.state, "{state}")
		.replaceAll(context.home, "{home}")
		.replaceAll(
			/(\{(?:state|scratch)\}\/(?:spec|todo)\/)[0-9a-f]{8}\//g,
			"$1{hash}/",
		)
		.replaceAll(
			/(\{scratch\}\/)[^\n]*?\/roundtable\//g,
			"$1<bucket>/roundtable/",
		)
		.replaceAll(/\S*\/spec-schema\/templates\//g, "{templates}/");
}

export function captureTree(
	root: string,
	context: SpecContext,
): Record<string, string> {
	const tree: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (name === ".git") continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else
				tree[relative(root, path)] = collapsePlaceholders(
					readFileSync(path, "utf8"),
					context,
				);
		}
	};
	walk(root);
	return tree;
}

export async function executeSpecCase(
	specCase: SpecCase,
	context: SpecContext,
	runner: SpecRunner,
): Promise<SpecOutcome> {
	mkdirSync(context.root, { recursive: true });
	for (const [name, content] of Object.entries(specCase.files ?? {})) {
		const expanded = expandPlaceholders(name, context);
		const path = isAbsolute(expanded) ? expanded : join(context.root, expanded);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	for (const step of specCase.git ?? []) runFixtureGit(step, context.root);
	const env = { ...baseEnv(context) };
	for (const [key, value] of Object.entries(specCase.env ?? {}))
		env[key] = expandPlaceholders(value, context);
	const run = await runner(
		specCase.args.map((arg) => expandPlaceholders(arg, context)),
		{ cwd: context.root, env, stdin: specCase.stdin },
	);
	return {
		status: run.exitCode,
		stdout: collapsePlaceholders(run.stdout, context),
		stderr: collapsePlaceholders(run.stderr, context),
		tree: captureTree(context.root, context),
	};
}

export const SPEC_ENTRY = join(import.meta.dir, "../src/index.ts");
export const SPEC_FIXED_DATE_PRELOAD = join(
	import.meta.dir,
	"spec-fixed-date.ts",
);
export const SOURCE_SKILLS = join(
	import.meta.dir,
	"../../../plugins/dg/skills",
);
export const SPEC_SKILLS_TREES = [
	"spec",
	"sdlc",
	"assign",
	"grill-me",
	"prd",
	"kick",
	"pickup",
] as const;

export async function collectRun(proc: {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}): Promise<SpecRun> {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

export const runSourceSpec: SpecRunner = (args, { cwd, env, stdin }) =>
	collectRun(
		Bun.spawn(
			[
				process.execPath,
				"--preload",
				SPEC_FIXED_DATE_PRELOAD,
				SPEC_ENTRY,
				"spec",
				...args,
			],
			{
				cwd,
				env: { DG_SKILLS_DIR: SOURCE_SKILLS, ...env },
				stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);

export function expectedTree(golden: SpecGolden): Record<string, string> {
	const tree: Record<string, string> = {};
	for (const [name, content] of Object.entries(golden.files ?? {}))
		if (!name.startsWith("{")) tree[name] = content;
	return { ...tree, ...golden.expect.tree };
}

export function splitFrontmatter(text: string): {
	data: unknown;
	body: string;
} {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (!match) throw new Error("text has no frontmatter block");
	return { data: Bun.YAML.parse(match[1] ?? ""), body: match[2] ?? "" };
}

export const LEGACY_PROGRAM = "spec-cli";
const CURRENT_PROGRAM = "dg-skills spec";

export function renameLegacyProgram(text: string): string {
	return text.replaceAll(LEGACY_PROGRAM, CURRENT_PROGRAM);
}
