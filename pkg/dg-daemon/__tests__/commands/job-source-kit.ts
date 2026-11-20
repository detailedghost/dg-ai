import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spyOn } from "bun:test";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { CommanderError, Command } from "commander";
import { defaultJobSourceDeps, type JobSourceDeps } from "../../src/commands/job-source";
import { registerJobCommands } from "../../src/commands/jobs";
import { cleanupDgHome, freshDgHome, freshTempDir } from "../utils/daemon-harness";
import { seedJobs } from "./job-cli-helpers";

const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "bot",
	GIT_AUTHOR_EMAIL: "bot@example.invalid",
	GIT_COMMITTER_NAME: "bot",
	GIT_COMMITTER_EMAIL: "bot@example.invalid",
};

export type RepoFile = string | { content: string; executable: true };
export type Repo = { dir: string; sha: string };
export type CommitInput = {
	dg?: unknown;
	files?: Record<string, RepoFile>;
	tag?: string;
	branch?: string;
};

export function gitIn(dir: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		env: { ...process.env, ...GIT_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

export const fileUrl = (repo: Repo): string => `file://${repo.dir}`;

function writeFiles(dir: string, files: Record<string, RepoFile>): void {
	for (const [path, file] of Object.entries(files)) {
		const target = join(dir, path);
		mkdirSync(dirname(target), { recursive: true });
		const content = typeof file === "string" ? file : file.content;
		writeFileSync(target, content);
		if (typeof file !== "string") chmodSync(target, 0o755);
	}
}

/** Adds one commit, optionally on a branch and with an annotated tag; the main branch stays checked out. */
export function commit(repo: Repo, input: CommitInput): string {
	if (input.branch) gitIn(repo.dir, ["checkout", "-B", input.branch]);
	writeFiles(repo.dir, input.files ?? {});
	if (input.dg !== undefined) {
		writeFileSync(
			join(repo.dir, "package.json"),
			JSON.stringify({ name: "fixture", dg: input.dg }),
		);
	}
	writeFileSync(join(repo.dir, ".stamp"), `${Math.random()}`);
	gitIn(repo.dir, ["add", "-A"]);
	gitIn(repo.dir, ["commit", "-m", "fixture"]);
	if (input.tag) gitIn(repo.dir, ["tag", "-a", input.tag, "-m", input.tag]);
	const sha = gitIn(repo.dir, ["rev-parse", "HEAD"]);
	if (input.branch) gitIn(repo.dir, ["checkout", "main"]);
	return sha;
}

export function makeRepo(input: { dg?: unknown; files?: Record<string, RepoFile> }): Repo {
	const dir = freshTempDir("job-repo");
	gitIn(dir, ["init", "-b", "main"]);
	const repo: Repo = { dir, sha: "" };
	repo.sha = commit(repo, { dg: input.dg, files: input.files });
	return repo;
}

export const jobDeclaration = (
	name = "bot",
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	jobs: { [name]: { argv: ["./bin/run"], continuous: true } },
	...extra,
});

export const QUICK_SCRIPT: RepoFile = {
	content: `#!${process.execPath}\nprocess.exit(0);\n`,
	executable: true,
};

export const RUN_SCRIPT: RepoFile = {
	content: `#!${process.execPath}\nsetTimeout(() => {}, 600000);\n`,
	executable: true,
};

export type Tools = { binDir: string; which: JobSourceDeps["which"] };

export function makeTools(names: string[]): Tools {
	const binDir = freshTempDir("job-tools");
	const found: Record<string, string> = {};
	for (const name of names) {
		const file = join(binDir, name);
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, 0o755);
		found[name] = file;
	}
	return {
		binDir,
		which: (name) => (name === "git" ? Bun.which("git") : (found[name] ?? null)),
	};
}

export type GitCall = {
	args: string[];
	env: Record<string, string | undefined>;
	stdin: "inherit" | "ignore";
};
export type BuildCall = { argv: string[]; cwd: string };

export type Sandbox = {
	dgHome: string;
	paths: DgPaths;
	tools: Tools;
	gitCalls: GitCall[];
	builds: BuildCall[];
	deps(over?: Partial<JobSourceDeps>): Partial<JobSourceDeps>;
};

export type RunOutcome = { code: number; stdout: string; stderr: string };

const saved: Record<string, string | undefined> = {};
const remember = (key: string) => {
	if (!(key in saved)) saved[key] = process.env[key];
};

/** In-process home for the source commands: DG_HOME and the git seams point at temp folders. */
export function sandbox(toolNames: string[] = ["tool", "sh"]) {
	const homes: string[] = [];
	return {
		create(jobs: Record<string, unknown> = {}): Sandbox {
			const dgHome = freshDgHome();
			homes.push(dgHome);
			seedJobs(dgHome, jobs);
			remember("DG_HOME");
			remember("DG_KEY_SOURCE");
			process.env.DG_HOME = dgHome;
			process.env.DG_KEY_SOURCE = "file";
			const tools = makeTools(toolNames);
			const gitCalls: GitCall[] = [];
			const builds: BuildCall[] = [];
			const real = defaultJobSourceDeps();
			return {
				dgHome,
				paths: resolveDgPaths({ env: { DG_HOME: dgHome } }),
				tools,
				gitCalls,
				builds,
				deps: (over = {}) => {
					const delegate: JobSourceDeps["runGit"] =
						over.runGit ??
						((args, options) =>
							real.runGit(args, { ...options, env: { ...options.env, ...GIT_ENV } }));
					return {
						confirm: async () => true,
						isTerminal: () => true,
						which: tools.which,
						runBuild: async (argv, cwd) => {
							builds.push({ argv, cwd });
							return Bun.spawnSync(argv, { cwd, stdout: "ignore", stderr: "ignore" })
								.exitCode;
						},
						...over,
						runGit: (args, options) => {
							gitCalls.push({ args, env: options.env, stdin: options.stdin });
							return delegate(args, options);
						},
					};
				},
			};
		},
		cleanup(): void {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			for (const key of Object.keys(saved)) delete saved[key];
			for (const home of homes.splice(0)) cleanupDgHome(home);
		},
	};
}

export async function runJob(
	args: string[],
	deps: Partial<JobSourceDeps>,
): Promise<RunOutcome> {
	const out: string[] = [];
	const err: string[] = [];
	const log = spyOn(console, "log").mockImplementation((...parts) => {
		out.push(parts.join(" "));
	});
	const error = spyOn(console, "error").mockImplementation((...parts) => {
		err.push(parts.join(" "));
	});
	let code = 0;
	try {
		const program = new Command().exitOverride();
		program.configureOutput({ writeErr: (text) => err.push(text), writeOut: () => {} });
		registerJobCommands(program, deps);
		await program.parseAsync(["job", ...args], { from: "user" });
	} catch (caught) {
		code =
			caught instanceof DgCliError || caught instanceof CommanderError
				? caught.exitCode
				: 1;
		err.push(caught instanceof Error ? caught.message : String(caught));
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
	return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Adds a repository as `name` through the CLI seams and throws when the add fails. */
export async function addFixture(
	sb: Sandbox,
	repo: Repo,
	name = "tools",
	extra: string[] = [],
): Promise<RunOutcome> {
	const outcome = await runJob(["add", fileUrl(repo), "--name", name, "--yes", ...extra], sb.deps());
	if (outcome.code !== 0) throw new Error(`add failed: ${outcome.stderr}`);
	return outcome;
}

/** Adds a second commit with a changed `dg` block and returns its id. */
export const changeBlock = (
	repo: Repo,
	dg: unknown,
	files: Record<string, RepoFile> = {},
): string => commit(repo, { dg, files });

export const FAKE_BUN = "/opt/dg-fake/bin/bun";

/** Deps whose `which` finds a fixed bun; `bun: null` finds none. */
export function withBun(
	sb: Sandbox,
	over: Partial<JobSourceDeps> & { bun?: string | null } = {},
): Partial<JobSourceDeps> {
	const { bun = FAKE_BUN, ...rest } = over;
	return sb.deps({
		which: (name) => (name === "bun" ? bun : sb.tools.which(name)),
		...rest,
	});
}

/** Writes one script into a fresh folder; the file name keeps its case. */
export function makeScript(
	name: string,
	content = "process.exit(0);\n",
	options: { executable?: boolean; dir?: string } = {},
): string {
	const file = join(options.dir ?? freshTempDir("job-script"), name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	chmodSync(file, options.executable ? 0o755 : 0o644);
	return file;
}

/** Makes a temp folder named `name` with a package.json that holds the `dg` block. */
export function makeFolder(input: {
	name?: string;
	dg?: unknown;
	files?: Record<string, RepoFile>;
}): string {
	const dir = join(freshTempDir("job-folder"), input.name ?? "toolkit");
	mkdirSync(dir, { recursive: true });
	if (input.dg !== undefined) {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", dg: input.dg }));
	}
	writeFiles(dir, input.files ?? {});
	return dir;
}

export const readConfig = (sb: Sandbox): { jobs: Record<string, Record<string, unknown>> } =>
	JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8"));

export const readRegistry = (sb: Sandbox): Record<string, Record<string, unknown>> => {
	try {
		return JSON.parse(readFileSync(sb.paths.jobSourcesPath, "utf8"));
	} catch {
		return {};
	}
};

export const BIN_RUN: RepoFile = { content: "#!/bin/sh\nexit 0\n", executable: true };
