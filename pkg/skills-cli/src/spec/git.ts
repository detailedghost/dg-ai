import { runCapture } from "@dg/common/node";
import { branchExists, originBase } from "../worktree/shared";
import { stripNewlines } from "./shared";

export interface GitResult {
	status: number;
	stdout: string;
}

/** Run git in a directory; null when git or the directory is unavailable. */
export async function git(
	cwd: string,
	args: string[],
): Promise<GitResult | null> {
	try {
		const result = await runCapture("git", args, { cwd, stdin: null });
		return { status: result.status, stdout: result.stdout };
	} catch {
		return null;
	}
}

export async function repoToplevel(dir: string): Promise<string | null> {
	const result = await git(dir, ["rev-parse", "--show-toplevel"]);
	if (result === null || result.status !== 0) return null;
	const top = stripNewlines(result.stdout);
	return top === "" ? null : top;
}

async function verified(cwd: string, ref: string): Promise<boolean> {
	const result = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
	return result?.status === 0;
}

async function defaultRef(cwd: string): Promise<string | null> {
	const name = await originBase(cwd);
	if (name !== "" && (await verified(cwd, `refs/remotes/origin/${name}`)))
		return `origin/${name}`;
	for (const local of [name, "main", "master"])
		if (local !== "" && (await branchExists(cwd, local))) return local;
	return null;
}

/** Commit subjects on `merge-base..HEAD` against the default branch; throws when the range cannot be read. */
export async function branchSubjects(cwd: string): Promise<string> {
	if ((await repoToplevel(cwd)) === null)
		throw new Error(`not inside a git repo: ${cwd}`);
	const base = await defaultRef(cwd);
	if (base === null)
		throw new Error(`cannot resolve the default branch in ${cwd}`);
	const mergeBase = await git(cwd, ["merge-base", "HEAD", base]);
	if (mergeBase === null || mergeBase.status !== 0)
		throw new Error(`cannot find merge-base with ${base} in ${cwd}`);
	const log = await git(cwd, [
		"log",
		"--pretty=%s",
		`${stripNewlines(mergeBase.stdout)}..HEAD`,
	]);
	if (log === null || log.status !== 0)
		throw new Error(`git log failed in ${cwd}`);
	return log.stdout;
}

/** True when a subject in `subjects` is a conventional commit that opens with `slice-<id>:`. */
export function sliceCommitted(subjects: string, id: string): boolean {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`^[a-z]+(\\([^()\\n]+\\))?!?: slice-${escaped}:`,
		"m",
	).test(subjects);
}
