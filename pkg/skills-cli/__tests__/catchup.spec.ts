import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isolateCliTests, readCalls, runGit } from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeTempDir, scratchFixtures } from "./git-repo-fixtures";

const CLI = join(import.meta.dir, "../src/index.ts");
const CATCHUP = join(import.meta.dir, "../src/catchup/index.ts");
const BUN = process.execPath;
const REAL_GIT = Bun.which("git")!;
const fixtures = scratchFixtures();
isolateCliTests();
afterEach(() => fixtures.cleanup());

type Call = { tool: string; args: string[]; cwd: string };
let tools: string;
let log: string;

beforeEach(() => {
	tools = fixtures.tmp("dg catchup tools ");
	log = join(tools, "calls.jsonl");
	for (const name of ["bash", "dirname", "sed", "wc", "tr", "find"]) {
		const path = Bun.which(name, { PATH: "/usr/bin:/bin" });
		if (!path) throw new Error(`Missing fixture utility ${name}`);
		symlinkSync(path, join(tools, name));
	}
	for (const tool of ["bun", "npm", "dotnet", "uv", "go", "dbt"]) {
		writeFakeCli(
			tools,
			tool,
			`#!${BUN}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool:${JSON.stringify(tool)}, args, cwd:process.cwd()}) + "\\n");
console.log(${JSON.stringify(`${tool} stdout`)});
console.error(${JSON.stringify(`${tool} stderr`)});
process.exit(process.env.FAIL_TOOL === ${JSON.stringify(tool)} ? 7 : 0);
`,
		);
	}
	writeFakeCli(
		tools,
		"git",
		`#!${BUN}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool:"git", args, cwd:process.cwd()}) + "\\n");
if (process.env.FAKE_UNCHANGED_REBASE === "1" && args[0] === "rebase") process.exit(0);
const result = Bun.spawnSync([${JSON.stringify(REAL_GIT)}, ...args], { stdin:"ignore", stdout:"inherit", stderr:"inherit" });
process.exit(result.exitCode);
`,
	);
});

describe("relocated compiled catchup", () => {
	let bundle: string;
	let stage: string;
	let binary: string;
	let home: string;
	let skills: string;
	let installedSkill: string;
	let skillBytes: Buffer;

	beforeAll(() => {
		bundle = makeTempDir("dg compiled catchup ");
		stage = join(bundle, "temporary build stage");
		home = join(bundle, "relocated installed home");
		binary = join(home, ".dg/bin/dg-skills");
		skills = join(home, "plugins/dg/skills");
		installedSkill = join(skills, "catchup/SKILL.md");
		mkdirSync(stage, { recursive: true });
		mkdirSync(dirname(binary), { recursive: true });
		const compiled = join(stage, "dg-skills");
		const build = Bun.spawnSync(
			[BUN, join(import.meta.dir, "../build.ts"), "--outfile", compiled],
			{
				cwd: join(import.meta.dir, "../../.."),
				env: { ...process.env },
			},
		);
		if (build.exitCode !== 0)
			throw new Error(`catchup compile failed: ${build.stderr.toString()}`);
		const sourceSkill = join(
			import.meta.dir,
			"../../../plugins/dg/skills/catchup",
		);
		skillBytes = readFileSync(join(sourceSkill, "SKILL.md"));
		cpSync(sourceSkill, join(skills, "catchup"), { recursive: true });
		renameSync(compiled, binary);
		rmSync(stage, { recursive: true, force: true });
	}, 120_000);

	afterAll(() => {
		if (bundle) rmSync(bundle, { recursive: true, force: true });
	});

	function nativeEnvironment() {
		const bin = fixtures.tmp("dg compiled catchup native tools ");
		symlinkSync(REAL_GIT, join(bin, "git"));
		const trace = join(fixtures.tmp("dg compiled catchup trace "), "git.log");
		return {
			bin,
			trace,
			env: {
				...process.env,
				PATH: bin,
				HOME: home,
				XDG_CONFIG_HOME: home,
				DG_HOME: undefined,
				DG_SKILLS: undefined,
				DG_SKILLS_DIR: skills,
				CLAUDE_PLUGIN_ROOT: dirname(skills),
				GIT_TRACE: trace,
				NODE_OPTIONS: undefined,
				BUN_OPTIONS: undefined,
			},
		};
	}

	function runCompiled(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
		const proc = Bun.spawnSync([binary, "catchup", ...args], {
			cwd,
			env,
			stdin: "ignore",
		});
		return {
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	}

	test("runs after physical relocation and pushes with force-with-lease using a Git-only PATH", () => {
		const repo = makeRepo();
		const upstream = advance(repo);
		const native = nativeEnvironment();
		expect(existsSync(stage)).toBe(false);
		expect(readFileSync(installedSkill).equals(skillBytes)).toBe(true);
		expect(readdirSync(native.bin)).toEqual(["git"]);
		const result = runCompiled(repo.dir, [], native.env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`No recognized project type found at ${repo.dir}`,
		);
		expect(result.stdout).toContain("Pushed: YES");
		expectRebased(repo, upstream);
		expect(remoteFeature(repo)).toBe(git(repo.dir, ["rev-parse", "HEAD"]));
		expect(readFileSync(native.trace, "utf8")).toContain(
			"git push --force-with-lease",
		);
	});

	test("restores modified, staged, and untracked files while the final no-push flag keeps the origin unchanged", () => {
		const repo = makeRepo();
		const upstream = advance(repo);
		put(repo.dir, "work.txt", "compiled modified work\n");
		put(repo.dir, "stage.txt", "compiled staged work\n");
		git(repo.dir, ["add", "stage.txt"]);
		put(repo.dir, "untracked.txt", "compiled untracked work\n");
		const diff = trackedDiff(repo.dir);
		const native = nativeEnvironment();
		const result = runCompiled(repo.dir, ["--push", "--no-push"], native.env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Restoring stash");
		expect(result.stdout).toContain("Push skipped: --no-push flag set");
		expectRebased(repo, upstream);
		expect(trackedDiff(repo.dir)).toBe(diff);
		expect(readFileSync(join(repo.dir, "untracked.txt"), "utf8")).toBe(
			"compiled untracked work\n",
		);
		expect(git(repo.dir, ["stash", "list"])).toBe("");
		expect(remoteFeature(repo)).toBe(repo.head);
		expect(readFileSync(native.trace, "utf8")).not.toContain("git push");
	});

	test("keeps the rebased local history and merges failing fake npm streams without publishing", () => {
		const repo = makeRepo();
		const upstream = advance(repo, {
			"package.json": '{"scripts":{"build":"ignored","test":"ignored"}}\n',
		});
		const native = nativeEnvironment();
		const toolLog = join(fixtures.tmp("dg compiled npm log "), "calls.log");
		writeFakeCli(
			native.bin,
			"npm",
			`#!/bin/sh
printf '%s\\n' "$PWD" "$@" >> "$COMPILED_TOOL_LOG"
printf 'compiled npm stdout\\n'
printf 'compiled npm stderr\\n' >&2
exit 7
`,
		);
		expect(readdirSync(native.bin).sort()).toEqual(["git", "npm"]);
		const result = runCompiled(repo.dir, [], {
			...native.env,
			COMPILED_TOOL_LOG: toolLog,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			"[node/npm] Building...\ncompiled npm stdout\ncompiled npm stderr\n",
		);
		expect(result.stderr).not.toContain("compiled npm stderr");
		expect(result.stdout).toContain("VERIFICATION FAILED after rebase.");
		expect(readCalls(toolLog)).toEqual([repo.dir, "run", "build"]);
		expectRebased(repo, upstream);
		expect(remoteFeature(repo)).toBe(repo.head);
		expect(readFileSync(native.trace, "utf8")).not.toContain("git push");
	});

	test("executes the installed skill bootstrap snippet from an external repo without downloading", () => {
		const repo = makeRepo();
		const native = nativeEnvironment();
		const snippet = readFileSync(installedSkill, "utf8").match(
			/```bash\n([\s\S]*?)```/,
		)?.[1];
		expect(snippet).toBeTruthy();
		const proc = Bun.spawnSync(["/bin/sh", "-c", snippet!], {
			cwd: repo.dir,
			env: native.env,
			stdin: "ignore",
		});
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toContain(
			"Already up to date with origin/main.",
		);
		expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head);
		expect(remoteFeature(repo)).toBe(repo.head);
		expect(readdirSync(native.bin)).toEqual(["git"]);
	});
});

function calls(): Call[] {
	return readCalls(log).map((line) => JSON.parse(line));
}
function git(cwd: string, args: string[]): string {
	return runGit(args, cwd).trim();
}
function put(cwd: string, file: string, text: string): void {
	mkdirSync(dirname(join(cwd, file)), { recursive: true });
	writeFileSync(join(cwd, file), text);
}
function commit(
	cwd: string,
	files: Record<string, string>,
	subject: string,
): string {
	for (const [file, text] of Object.entries(files)) put(cwd, file, text);
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-q", "-m", subject]);
	return git(cwd, ["rev-parse", "HEAD"]);
}
function makeRepo(branch = "main", upstream = true) {
	const root = fixtures.tmp("dg catchup repos ");
	const bare = join(root, "local origin.git");
	const seed = join(root, "upstream author");
	const dir = join(root, "feature checkout");
	fixtures.git(["init", "--bare", "-q", "-b", branch, bare], root);
	fixtures.git(["init", "-q", "-b", branch, seed], root);
	for (const [key, value] of [
		["user.email", "test@example.invalid"],
		["user.name", "Test"],
	])
		git(seed, ["config", key!, value!]);
	const base = commit(
		seed,
		{
			"README.md": "base\n",
			"work.txt": "clean work\n",
			"stage.txt": "clean stage\n",
		},
		"base",
	);
	git(seed, ["remote", "add", "origin", bare]);
	git(seed, ["push", "-q", "-u", "origin", branch]);
	fixtures.git(["clone", "-q", bare, dir], root);
	for (const [key, value] of [
		["user.email", "test@example.invalid"],
		["user.name", "Test"],
	])
		git(dir, ["config", key!, value!]);
	git(dir, ["checkout", "-q", "-b", "feature"]);
	const head = commit(dir, { "feature.txt": "feature\n" }, "feature work");
	if (upstream) git(dir, ["push", "-q", "-u", "origin", "feature"]);
	return { dir, bare, seed, branch, base, head };
}
type Repo = ReturnType<typeof makeRepo>;
function advance(
	repo: Repo,
	files: Record<string, string> = { "upstream.txt": "upstream\n" },
	subject = "upstream work",
): string {
	git(repo.seed, ["checkout", "-q", repo.branch]);
	const sha = commit(repo.seed, files, subject);
	git(repo.seed, ["push", "-q"]);
	return sha;
}
function runCatchup(
	cwd: string,
	args: string[] = [],
	env: Record<string, string> = {},
) {
	writeFileSync(log, "");
	const proc = Bun.spawnSync([BUN, "run", CLI, "catchup", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdin: "ignore",
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}
function trackedDiff(dir: string) {
	return git(dir, ["diff", "HEAD", "--", "work.txt", "stage.txt"]);
}
function remoteFeature(repo: Repo) {
	return git(repo.dir, ["ls-remote", "origin", "refs/heads/feature"]).split(
		/\s/,
	)[0];
}
function expectRebased(repo: Repo, upstream: string) {
	expect(git(repo.dir, ["rev-parse", "HEAD^"])).toBe(upstream);
	expect(git(repo.dir, ["show", "HEAD:feature.txt"])).toBe("feature");
	expect(git(repo.dir, ["rev-parse", "HEAD"])).not.toBe(repo.head);
}

describe("catchup CLI", () => {
	test("returns shell-compatible status 127 when Git is unavailable before any later step", () => {
		const noGit = fixtures.tmp("dg catchup missing git tools ");
		for (const name of ["sh", "dirname", "sed", "wc", "tr", "find", "grep"])
			symlinkSync(`/usr/bin/${name}`, join(noGit, name));
		for (const name of ["bun", "npm", "dotnet", "uv", "go", "dbt"])
			symlinkSync(join(tools, name), join(noGit, name));
		const result = runCatchup(fixtures.tmp("dg catchup missing git cwd "), [], {
			PATH: noGit,
		});
		expect(result.exitCode).toBe(127);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/git[^\n]*(?:not found|ENOENT|executable)/i);
		expect(calls()).toEqual([]);
	});
	test("propagates Git status 128 outside a repository without running later steps", () => {
		const result = runCatchup(fixtures.tmp("dg catchup outside git "));
		expect(result.exitCode).toBe(128);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("not a git repository");
		expect(calls().map((call) => call.args)).toEqual([["rev-parse", "HEAD"]]);
	});
	test("prints command-specific help outside a repository without running tools", () => {
		const cwd = fixtures.tmp("dg catchup help ");
		const result = runCatchup(cwd, ["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("catchup");
		expect(result.stdout).toContain("--no-push");
		expect(result.stdout).toContain("--push");
		expect(result.stderr).toBe("");
		expect(calls()).toEqual([]);
	});

	test("imports the domain without spawning commands, reading files, or writing state", () => {
		const cwd = fixtures.tmp("dg catchup import ");
		const proc = Bun.spawnSync(
			[
				BUN,
				"-e",
				`
const fs = require("node:fs");
const unexpected = () => { throw new Error("unexpected import side effect"); };
Bun.spawn = unexpected; Bun.spawnSync = unexpected; Bun.file = unexpected; Bun.write = unexpected;
for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync"]) fs[name] = unexpected;
await import(${JSON.stringify(CATCHUP)});
console.log("loaded");
`,
			],
			{ cwd, env: { ...process.env } },
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("loaded\n");
		expect(proc.stderr.toString()).toBe("");
		expect(readCalls(log)).toEqual([]);
	});

	test.each(["--unknown", "operand", "--"])(
		"rejects %s on stderr before touching Git",
		(flag) => {
			const result = runCatchup(fixtures.tmp("dg catchup bad argument "), [
				flag,
			]);
			expect(result).toEqual({
				exitCode: 1,
				stdout: "",
				stderr: `Unknown flag: ${flag}\n`,
			});
			expect(calls()).toEqual([]);
		},
	);

	test.each(["staged", "modified", "untracked"])(
		"up-to-date return preserves %s changes and skips verification/push",
		(kind) => {
			const repo = makeRepo();
			if (kind === "untracked") put(repo.dir, "untracked.txt", "keep me\n");
			else {
				put(repo.dir, "work.txt", "dirty work\n");
				if (kind === "staged") git(repo.dir, ["add", "work.txt"]);
			}
			const diff = trackedDiff(repo.dir);
			const result = runCatchup(repo.dir);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Already up to date with origin/main.");
			expect(result.stdout).not.toContain("Verifying build");
			expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head);
			expect(trackedDiff(repo.dir)).toBe(diff);
			expect(git(repo.dir, ["stash", "list"])).toBe("");
			const actions = calls()
				.filter((call) => call.tool === "git")
				.map((call) => call.args[0]);
			expect(actions).not.toContain("rebase");
			expect(actions).not.toContain("push");
			expect(calls().filter((call) => call.tool !== "git")).toEqual([]);
			if (kind === "untracked") {
				expect(result.stdout).not.toContain("Stashing");
				expect(readFileSync(join(repo.dir, "untracked.txt"), "utf8")).toBe(
					"keep me\n",
				);
			} else {
				expect(result.stdout).toContain("Restoring stash");
				expect(
					calls()
						.filter(
							(call) =>
								call.args[0] === "stash" &&
								["push", "pop"].includes(call.args[1]!),
						)
						.map((call) => call.args),
				).toEqual([
					["stash", "push", "-m", "catchup-auto-stash"],
					["stash", "pop"],
				]);
			}
		},
	);

	test.each([[[]], [["--push"]]])(
		"rebases, restores tracked changes and untracked files, verifies, then pushes by default with %j",
		(args) => {
			const repo = makeRepo();
			const upstream = advance(repo);
			put(repo.dir, "work.txt", "dirty work\n");
			put(repo.dir, "stage.txt", "dirty stage\n");
			git(repo.dir, ["add", "stage.txt"]);
			put(repo.dir, "untracked.txt", "untracked content\n");
			const diff = trackedDiff(repo.dir);
			const result = runCatchup(repo.dir, args);
			expect(result.exitCode).toBe(0);
			expectRebased(repo, upstream);
			expect(trackedDiff(repo.dir)).toBe(diff);
			expect(readFileSync(join(repo.dir, "untracked.txt"), "utf8")).toBe(
				"untracked content\n",
			);
			expect(git(repo.dir, ["stash", "list"])).toBe("");
			expect(remoteFeature(repo)).toBe(git(repo.dir, ["rev-parse", "HEAD"]));
			expect(result.stdout).toContain("Pushed: YES");
			const ordered = [
				"Stashing",
				"Default branch",
				"Fetching",
				"Rebasing",
				"Rebase successful",
				"Restoring stash",
				"Verifying build",
				"Pushing",
				"Catchup complete",
			];
			let previous = -1;
			for (const marker of ordered) {
				const position = result.stdout.indexOf(marker);
				expect(position).toBeGreaterThan(previous);
				previous = position;
			}
			expect(calls().find((call) => call.args[0] === "push")?.args).toEqual([
				"push",
				"--force-with-lease",
				"origin",
				"HEAD:refs/heads/feature",
			]);
			expect(calls().find((call) => call.args[0] === "rebase")?.args).toEqual([
				"rebase",
				"--onto",
				"refs/remotes/origin/main",
				repo.base,
				"feature",
				"--no-reapply-cherry-picks",
			]);
		},
	);

	test.each(["symbolic", "main fallback", "master fallback"])(
		"detects the default branch using %s",
		(mode) => {
			const branch =
				mode === "symbolic"
					? "trunk"
					: mode === "master fallback"
						? "master"
						: "main";
			const repo = makeRepo(branch);
			const upstream = advance(repo);
			if (mode !== "symbolic")
				git(repo.dir, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
			const result = runCatchup(repo.dir, ["--no-push"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`Default branch: ${branch}`);
			expect(calls().find((call) => call.args[0] === "fetch")?.args).toEqual([
				"fetch",
				"origin",
				branch,
			]);
			expectRebased(repo, upstream);
		},
	);

	test("caps the incoming log at twenty commits while counting all incoming commits", () => {
		const repo = makeRepo();
		for (let index = 1; index <= 23; index++)
			commit(repo.seed, { "upstream.txt": `${index}\n` }, `incoming-${index}`);
		git(repo.seed, ["push", "-q"]);
		const result = runCatchup(repo.dir, ["--no-push"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("23 new commit(s)");
		expect(result.stdout.match(/^[a-f0-9]+ incoming-\d+$/gm)).toHaveLength(20);
		expect(
			calls()
				.filter((call) => call.args[0] === "log")
				.map((call) => call.args),
		).toContainEqual([
			"log",
			"--oneline",
			"-n",
			"20",
			"HEAD..refs/remotes/origin/main",
		]);
	});

	test("uses the true merge base and drops feature patches already present upstream", () => {
		const repo = makeRepo();
		git(repo.seed, ["fetch", "-q", "origin", "feature"]);
		git(repo.seed, ["cherry-pick", "--no-commit", repo.head]);
		git(repo.seed, ["commit", "-q", "-m", "upstream landed feature"]);
		const upstream = advance(repo, { "upstream.txt": "after merged patch\n" });
		const result = runCatchup(repo.dir, ["--no-push"]);
		expect(result.exitCode).toBe(0);
		expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(upstream);
		expect(git(repo.dir, ["rev-list", "--count", `${upstream}..HEAD`])).toBe(
			"0",
		);
		expect(calls().find((call) => call.args[0] === "rebase")?.args).toEqual([
			"rebase",
			"--onto",
			"refs/remotes/origin/main",
			repo.base,
			"feature",
			"--no-reapply-cherry-picks",
		]);
	});

	test("reports a fetch failure on stderr and leaves the auto-stash available for recovery", () => {
		const repo = makeRepo();
		put(repo.dir, "work.txt", "recoverable dirty edit\n");
		git(repo.dir, [
			"remote",
			"set-url",
			"origin",
			join(fixtures.tmp("dg absent origin "), "missing.git"),
		]);
		const result = runCatchup(repo.dir);
		expect(result.exitCode).toBe(128);
		expect(result.stdout).toContain("Fetching origin/main");
		expect(result.stderr).toContain("does not appear to be a git repository");
		expect(result.stderr).toContain("git stash pop");
		expect(result.stdout).not.toContain("Restoring stash");
		expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head);
		expect(git(repo.dir, ["stash", "list"])).toContain("catchup-auto-stash");
		expect(git(repo.dir, ["show", "stash:work.txt"])).toBe(
			"recoverable dirty edit",
		);
		expect(
			calls().some((call) => ["rebase", "push"].includes(call.args[0])),
		).toBe(false);
	});

	test("fails early on a detached HEAD without stashing or rebasing", () => {
		const repo = makeRepo();
		git(repo.dir, ["checkout", "-q", "--detach"]);
		put(repo.dir, "work.txt", "dirty detached\n");
		const result = runCatchup(repo.dir);
		const recorded = calls();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("HEAD is detached");
		expect(git(repo.dir, ["stash", "list"])).toBe("");
		expect(
			recorded.some((call) =>
				["stash", "rebase", "push"].includes(call.args[0]),
			),
		).toBe(false);
	});

	test("aborts a conflicting rebase, restores dirty work, and keeps the local and remote feature tips", () => {
		const repo = makeRepo();
		const before = commit(
			repo.dir,
			{ "README.md": "feature conflict\n" },
			"feature conflict",
		);
		git(repo.dir, ["push", "-q"]);
		advance(repo, { "README.md": "upstream conflict\n" });
		put(repo.dir, "work.txt", "dirty preserved\n");
		const result = runCatchup(repo.dir);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("CONFLICT detected during rebase!");
		expect(result.stdout).toContain("README.md");
		expect(result.stdout).toContain("Aborting rebase");
		expect(result.stdout).toContain("Restoring stash");
		expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(before);
		expect(remoteFeature(repo)).toBe(before);
		expect(readFileSync(join(repo.dir, "work.txt"), "utf8")).toBe(
			"dirty preserved\n",
		);
		expect(git(repo.dir, ["stash", "list"])).toBe("");
		expect(existsSync(join(repo.dir, ".git/rebase-merge"))).toBe(false);
		expect(
			calls()
				.filter((call) => call.args[0] === "rebase")
				.map((call) => call.args),
		).toContainEqual(["rebase", "--abort"]);
		expect(result.stdout).not.toContain("Verifying build");
		expect(calls().some((call) => call.args[0] === "push")).toBe(false);
	});

	test("retains the stash and successful rebase when stash restoration conflicts", () => {
		const repo = makeRepo();
		const upstream = advance(repo, { "work.txt": "upstream edit\n" });
		put(repo.dir, "work.txt", "dirty edit\n");
		const result = runCatchup(repo.dir);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("WARNING: stash pop had conflicts.");
		expectRebased(repo, upstream);
		expect(git(repo.dir, ["diff", "--name-only", "--diff-filter=U"])).toBe(
			"work.txt",
		);
		expect(git(repo.dir, ["stash", "list"])).toContain("catchup-auto-stash");
		expect(remoteFeature(repo)).toBe(repo.head);
		expect(result.stdout).not.toContain("Verifying build");
	});

	test("merges verifier child stdout and stderr onto stdout and preserves a failed verification without pushing", () => {
		const repo = makeRepo();
		const upstream = advance(repo, {
			"package.json": '{"scripts":{"build":"ignored","test":"ignored"}}\n',
		});
		const result = runCatchup(repo.dir, [], { FAIL_TOOL: "bun" });
		expect(result.exitCode).toBe(1);
		expectRebased(repo, upstream);
		expect(result.stdout).toContain("bun stdout\nbun stderr\n");
		expect(result.stderr).not.toContain("bun stderr");
		expect(result.stdout).toContain("VERIFICATION FAILED after rebase.");
		expect(
			calls()
				.filter((call) => call.tool === "bun")
				.map((call) => call.args),
		).toEqual([["run", "build"]]);
		expect(remoteFeature(repo)).toBe(repo.head);
		expect(calls().some((call) => call.args[0] === "push")).toBe(false);
	});

	test.each(["main", "master", "develop"])(
		"rebases protected %s locally but skips pushing it",
		(branch) => {
			const repo = makeRepo(branch);
			git(repo.dir, ["checkout", "-q", branch]);
			const upstream = advance(repo);
			const result = runCatchup(repo.dir);
			expect(result.exitCode).toBe(0);
			expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(upstream);
			expect(result.stdout).toContain(
				`refusing to force-push protected branch '${branch}'`,
			);
			expect(result.stdout).toContain("Pushed: NO");
			expect(calls().some((call) => call.args[0] === "push")).toBe(false);
		},
	);

	test.each(["--no-push", "no upstream", "HEAD unchanged"])(
		"skips a push after verification for %s",
		(reason) => {
			const repo = makeRepo("main", reason !== "no upstream");
			const upstream = advance(repo);
			const result = runCatchup(
				repo.dir,
				reason === "--no-push" ? ["--no-push"] : [],
				reason === "HEAD unchanged" ? { FAKE_UNCHANGED_REBASE: "1" } : {},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Verifying build");
			expect(result.stdout).toContain("Pushed: NO");
			expect(result.stdout).toContain(
				reason === "--no-push"
					? "--no-push flag set"
					: reason === "no upstream"
						? "no upstream configured for 'feature'"
						: "HEAD unchanged",
			);
			expect(calls().some((call) => call.args[0] === "push")).toBe(false);
			if (reason === "HEAD unchanged")
				expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head);
			else expectRebased(repo, upstream);
		},
	);

	test("fails a stale force-with-lease without undoing the successful local rebase", () => {
		const repo = makeRepo();
		const upstream = advance(repo);
		git(repo.seed, ["fetch", "-q", "origin", "feature"]);
		git(repo.seed, ["checkout", "-q", "-b", "remote-feature", "FETCH_HEAD"]);
		const raced = commit(
			repo.seed,
			{ "race.txt": "someone else's feature work\n" },
			"remote advanced",
		);
		git(repo.seed, ["push", "-q", "origin", "HEAD:feature"]);
		const result = runCatchup(repo.dir);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("PUSH FAILED");
		expect(result.stdout).toContain("Your local rebase succeeded");
		expect(result.stderr).toContain("stale info");
		expectRebased(repo, upstream);
		expect(remoteFeature(repo)).toBe(raced);
		expect(
			calls()
				.filter((call) => call.args[0] === "push")
				.map((call) => call.args),
		).toEqual([
			["push", "--force-with-lease", "origin", "HEAD:refs/heads/feature"],
		]);
		expect(result.stdout).not.toContain("Catchup complete!");
	});
});
