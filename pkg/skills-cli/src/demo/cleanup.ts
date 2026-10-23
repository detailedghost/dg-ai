/** Owned-artifact cleanup: delete only paths that are both new since a pre-run baseline and match one of this run's own artifact patterns — never anything already dirty or untracked. */

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

/** Deletes only paths new since `baseline` that match one of `ownedPatterns`; returns the paths it removed. */
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
