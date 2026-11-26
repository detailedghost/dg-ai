import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, jobSourceDir } from "@dg/common/node";
import { findRecordByJob, readSourceRecords } from "./sources";

type PinPaths = Pick<DgPaths, "jobsDir" | "jobSourcesPath">;

function gitEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).flatMap(([key, value]) =>
			value === undefined || key.startsWith("GIT_") ? [] : [[key, value]],
		),
	);
}

type GitOut = { code: number; stdout: string };
type Head = { sha: string; tree: string; dirty: string[]; hidden: string[]; excludes: boolean };

const HEAD_ARGS = ["rev-parse", "HEAD", "HEAD^{tree}"];
const STATUS_ARGS = ["status", "--porcelain", "--untracked-files=all"];
const INDEX_ARGS = ["ls-files", "-v"];
const gitArgv = (args: string[]) => ["git", "-c", "core.fsmonitor=false", "-c", "core.excludesFile=/dev/null", ...args];
const spawnOptions = (clone: string) => ({
	cwd: clone,
	env: gitEnv(),
	stdin: "ignore",
	stdout: "pipe",
	stderr: "ignore",
}) as const;

function runGitSync(clone: string, args: string[]): GitOut {
	const result = Bun.spawnSync(gitArgv(args), spawnOptions(clone));
	return { code: result.exitCode, stdout: result.stdout.toString() };
}

async function runGit(clone: string, args: string[]): Promise<GitOut> {
	const proc = Bun.spawn(gitArgv(args), spawnOptions(clone));
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { code, stdout };
}

function unreadableClone(clone: string, name: string): DgCliError {
	return new DgCliError(`dg job: cannot read the git clone of "${name}" at ${clone}. Next: run dg job remove ${name}, then dg job add it again.`);
}

function hasLocalExcludes(clone: string, name: string): boolean {
	try {
		return readFileSync(join(clone, ".git", "info", "exclude"), "utf8")
			.split("\n")
			.some((line) => line.trim() !== "" && !line.startsWith("#"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw unreadableClone(clone, name);
	}
}

function parseHead(head: GitOut, status: GitOut, index: GitOut, clone: string, name: string): Head {
	const [sha, tree] = head.stdout.trim().split("\n");
	if (head.code !== 0 || status.code !== 0 || index.code !== 0 || !sha || !tree) {
		throw unreadableClone(clone, name);
	}
	return {
		sha,
		tree,
		dirty: status.stdout.split("\n").filter((line) => line !== ""),
		hidden: index.stdout.split("\n").filter((line) => /^[a-zS] /.test(line)).map((line) => line.slice(2)),
		excludes: hasLocalExcludes(clone, name),
	};
}

type PinPlan = { clone: string; commit: string; tree: string | undefined };

function planOf(name: string, paths: PinPaths): PinPlan | undefined {
	const found = findRecordByJob(readSourceRecords(paths), name);
	if (found?.record.kind !== "git") return undefined;
	const { source, record } = found;
	if (record.pin?.kind === "sha256") {
		throw new DgCliError(`dg job: "${name}" has a sha256 pin, and a job plugin pins a full commit SHA. Next: run dg job remove ${name}, then dg job add it again.`);
	}
	return { clone: jobSourceDir(paths, source), commit: record.pin?.value ?? record.sha, tree: record.tree };
}

function judge(name: string, plan: PinPlan, head: Head): void {
	if (head.sha !== plan.commit) {
		throw new DgCliError(`dg job: the clone of "${name}" is at ${head.sha}, which is not the pinned commit ${plan.commit}. Next: run dg job update ${name}, or dg job remove ${name} and add it again.`);
	}
	if (plan.tree !== undefined && head.tree !== plan.tree) {
		throw new DgCliError(`dg job: the tree of "${name}" is ${head.tree}, not the recorded tree ${plan.tree}. Next: run dg job remove ${name}, then dg job add it again.`);
	}
	if (head.hidden.length > 0) {
		throw new DgCliError(`dg job: the clone of "${name}" hides tracked files from git with assume-unchanged or skip-worktree (${head.hidden.slice(0, 3).join(", ")}). Next: run dg job remove ${name}, then dg job add it again.`);
	}
	if (head.excludes) {
		throw new DgCliError(`dg job: the clone of "${name}" has local ignore rules in .git/info/exclude. Next: run dg job remove ${name}, then dg job add it again.`);
	}
	if (head.dirty.length > 0) {
		throw new DgCliError(`dg job: the clone of "${name}" has uncommitted changes (${head.dirty.slice(0, 3).map((line) => line.slice(3)).join(", ")}). Next: run dg job remove ${name}, then dg job add it again.`);
	}
}

/** Refuses a git job whose clone left its approved commit and tree, or holds a changed tracked file or an untracked file that .gitignore does not cover. */
export async function assertJobPinned(name: string, paths: PinPaths): Promise<void> {
	const plan = planOf(name, paths);
	if (!plan) return;
	const [head, status, index] = await Promise.all([
		runGit(plan.clone, HEAD_ARGS),
		runGit(plan.clone, STATUS_ARGS),
		runGit(plan.clone, INDEX_ARGS),
	]);
	judge(name, plan, parseHead(head, status, index, plan.clone, name));
}

/** The blocking form of assertJobPinned, for a service start that must report its pid at once. */
export function assertJobPinnedSync(name: string, paths: PinPaths): void {
	const plan = planOf(name, paths);
	if (!plan) return;
	const head = runGitSync(plan.clone, HEAD_ARGS);
	const status = runGitSync(plan.clone, STATUS_ARGS);
	const index = runGitSync(plan.clone, INDEX_ARGS);
	judge(name, plan, parseHead(head, status, index, plan.clone, name));
}
