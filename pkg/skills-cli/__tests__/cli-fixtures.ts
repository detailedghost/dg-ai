import { afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git, makeTempDir, scratchFixtures } from "./git-repo-fixtures";

/** A PATH string with every directory that resolves vcs-provider-cli filtered out. */
export function pathWithoutVcsProviderCli(): string {
	return (process.env.PATH ?? "")
		.split(":")
		.filter((dir) => dir !== "" && !existsSync(join(dir, "vcs-provider-cli")))
		.join(":");
}

/** Create a temp dir that the caller's cleanup list removes. */
export function tmp(createdDirs: string[], prefix: string): string {
	const dir = makeTempDir(prefix);
	createdDirs.push(dir);
	return dir;
}

export function writeJson(createdDirs: string[], prefix: string, name: string, data: unknown): string {
	const path = join(tmp(createdDirs, prefix), name);
	writeFileSync(path, JSON.stringify(data));
	return path;
}

export function callLogPath(createdDirs: string[], prefix: string): string {
	return join(tmp(createdDirs, prefix), "calls.log");
}

export function readCalls(path: string): string[] {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function catchError(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

export function shScript(caseBody: string): string {
	return `#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
${caseBody}
  *)
    exit 0
    ;;
esac
`;
}

export function restPr(
	number: number,
	headRef: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		number,
		title: `PR #${number}`,
		html_url: `https://github.com/acme/widgets/pull/${number}`,
		state: "open",
		head: { ref: headRef },
		base: { ref: "main" },
		body: `body of PR ${number}`,
		merged_at: null,
		...overrides,
	};
}

export const runGit = git;

export function commitFile(dir: string, name: string, content: string, message: string): string {
	writeFileSync(join(dir, name), content);
	runGit(["add", name], dir);
	runGit(["commit", "-q", "-m", message], dir);
	return runGit(["rev-parse", "HEAD"], dir).trim();
}

/** Bootstraps a real git repo at `dir` with three commits and a tracked origin/HEAD, matching origin's shape. */
export function initTrackedRepo(dir: string, originUrl: string): { shaA: string; shaB: string; shaTip: string } {
	mkdirSync(dir, { recursive: true });
	runGit(["init", "-q"], dir);
	runGit(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
	runGit(["config", "user.email", "t@t.t"], dir);
	runGit(["config", "user.name", "T"], dir);
	const shaA = commitFile(dir, "base.txt", "base", "chore: base");
	const shaB = commitFile(dir, "upstream-1.txt", "up1", "chore: upstream one");
	const shaTip = commitFile(dir, "upstream-2.txt", "up2", "chore: upstream two");
	runGit(["remote", "add", "origin", originUrl], dir);
	runGit(["update-ref", "refs/remotes/origin/main", "refs/heads/main"], dir);
	runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], dir);
	return { shaA, shaB, shaTip };
}

export function glMr(
	iid: number,
	sourceBranch: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		iid,
		title: `MR !${iid}`,
		web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${iid}`,
		state: "opened",
		source_branch: sourceBranch,
		target_branch: "main",
		description: `body of MR ${iid}`,
		merged_at: null,
		...overrides,
	};
}

/** Keep all provider subprocesses away from host auth/config and real gh/glab. */
export function isolateCliTests(): void {
 const fixtures = scratchFixtures();
 const tools = ["git", "cat", "grep", "readlink", "sleep", "sh"].map(name => {
  const path = Bun.which(name);
  if (!path) throw new Error(`Required test tool missing: ${name}`);
  return { name, path };
 });
 let savedEnv: NodeJS.ProcessEnv;
 let savedCwd: string;
 beforeEach(() => {
  savedEnv = { ...process.env };
  savedCwd = process.cwd();
  for (const key of Object.keys(process.env)) {
   if (/^(?:GH_|GITHUB_|GLAB_|GITLAB_|GIT_|FAKE_|AI_VCS_|VCS_)/.test(key)) delete process.env[key];
  }
  const home = fixtures.tmp("dg-provider-home-");
  const bin = fixtures.tmp("dg-provider-tools-");
  for (const { name, path } of tools) symlinkSync(path, join(bin, name));
  Object.assign(process.env, {
   HOME: home, XDG_CONFIG_HOME: home, GH_CONFIG_DIR: home, GLAB_CONFIG_DIR: home,
   AI_SCRATCH_DIR: fixtures.tmp("dg-provider-scratch-"), AI_STATE_DIR: fixtures.tmp("dg-provider-state-"),
   PATH: bin, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
   GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
  });
 });
 afterEach(() => {
  process.chdir(savedCwd);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fixtures.cleanup();
 });
}
