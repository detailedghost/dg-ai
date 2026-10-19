import { runCapture } from "@dg/common/node";
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
