import { runCapture } from "@dg/common/node";

/** A failure the dispatcher reports as `worktree-cli: <message>` with exit 2. */
export class WorktreeError extends Error {}

export function fail(message: string): never {
	throw new WorktreeError(message);
}

export const infoLine = (message: string): string => `${message}\n`;

export const warnLine = (message: string): string =>
	`worktree-cli: ${message}\n`;

export function info(message: string): void {
	process.stderr.write(infoLine(message));
}

export function warn(message: string): void {
	process.stderr.write(warnLine(message));
}

/** Single-quote a value for `eval` only when it holds characters the shell would split or expand. */
export function shellValue(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", "'\\''")}'`;
}

/** Linked or primary checkout from `git worktree list --porcelain`; branch is null when detached. */
export interface WorktreeEntry {
	path: string;
	branch: string | null;
}

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
	const result = await runCapture("git", ["-C", cwd, ...args], { stdin: null });
	return {
		ok: result.status === 0,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export function parseWorktrees(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	for (const block of porcelain.split("\n\n")) {
		const lines = block.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
		if (!path) continue;
		const ref = lines.find((line) => line.startsWith("branch "))?.slice(7);
		entries.push({ path, branch: ref?.replace(/^refs\/heads\//, "") ?? null });
	}
	return entries;
}

/** Primary checkout first, then linked checkouts; fails outside a repository. */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
	const result = await git(cwd, ["worktree", "list", "--porcelain"]);
	const entries = result.ok ? parseWorktrees(result.stdout) : [];
	if (entries.length === 0) fail("not in a git repo");
	return entries;
}

export async function originBase(repo: string): Promise<string> {
	const result = await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
	return result.ok
		? result.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
		: "";
}

export async function branchExists(
	repo: string,
	branch: string,
): Promise<boolean> {
	return (
		await git(repo, [
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		])
	).ok;
}

export function lastSegment(branch: string): string {
	return branch.slice(branch.lastIndexOf("/") + 1);
}
