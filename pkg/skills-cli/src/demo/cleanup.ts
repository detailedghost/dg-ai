/**
 * Owned-artifact cleanup: a demo run (local or --ext) must never leave a stray
 * recording/screenshot/plan file lying around as a side effect, but it also must
 * never touch anything the user already had dirty or untracked before the run
 * started — a blanket `git clean` is exactly the failure mode this guards against.
 * Capture a baseline before the run, then after it, delete only paths that are both
 * new since that baseline and match one of this run's own artifact patterns.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

export type GitStatusBaseline = ReadonlySet<string>;

async function gitStatusPaths(cwd: string): Promise<Set<string>> {
	const proc = Bun.spawn(["git", "status", "--porcelain"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	const paths = new Set<string>();
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain v1: two status chars, a space, then the path (renames add " -> dest").
		const path = line.slice(3);
		const renamed = path.split(" -> ");
		paths.add(renamed[renamed.length - 1] as string);
	}
	return paths;
}

/** Call before the run starts. Not a git repo, or git itself unavailable, resolves to an empty baseline — cleanup then owns nothing and deletes nothing, rather than guessing. */
export async function captureBaseline(cwd: string): Promise<GitStatusBaseline> {
	try {
		return await gitStatusPaths(cwd);
	} catch {
		return new Set();
	}
}

/**
 * Delete only paths that are new since `baseline` AND match one of `ownedPatterns`.
 * A path present in the baseline is never touched, regardless of pattern — that is
 * the one invariant this function exists to hold, so it's checked first and alone.
 * Returns the paths it actually removed.
 */
export async function cleanupOwnedArtifacts(
	cwd: string,
	baseline: GitStatusBaseline,
	ownedPatterns: readonly RegExp[],
): Promise<string[]> {
	let after: Set<string>;
	try {
		after = await gitStatusPaths(cwd);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const path of after) {
		if (baseline.has(path)) continue;
		if (!ownedPatterns.some((pattern) => pattern.test(path))) continue;
		await rm(join(cwd, path), { force: true, recursive: true });
		removed.push(path);
	}
	return removed;
}
