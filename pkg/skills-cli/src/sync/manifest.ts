/**
 * Bounded pruning for generated outputs. Each target writes a manifest of the
 * names it produced on the last `apply`, and the next run deletes only names
 * that manifest once listed and no longer appears — never a name the target
 * never wrote. This is narrower than the legacy shell scripts, which deleted
 * every unmatched file in the destination regardless of who put it there;
 * plan.md's "bounds target pruning to generated outputs" authorizes the
 * narrower rule. See commit message for slice 28 (w7-sync).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** Read a newline-delimited manifest of names; a missing file reads as empty. */
export function readManifest(manifestPath: string): string[] {
	if (!existsSync(manifestPath)) return [];
	try {
		return readFileSync(manifestPath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && line !== "." && line !== ".." && !line.startsWith("/"));
	} catch {
		return [];
	}
}

/** Persist the exact set of names this run produced. */
export function writeManifest(manifestPath: string, names: readonly string[]): void {
	writeFileSync(manifestPath, `${names.join("\n")}\n`);
}

export interface PruneResult {
	pruned: string[];
}

/**
 * Remove `<dir>/<name><suffix>` for every manifest-listed name absent from
 * `keep`, then rewrite the manifest to exactly `keep`. `suffix` may be a file
 * extension (".md") or empty when names are directories.
 */
export function pruneStale(
	dir: string,
	suffix: string,
	manifestPath: string,
	keep: readonly string[],
	remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): PruneResult {
	const previouslyManaged = readManifest(manifestPath);
	const keepSet = new Set(keep);
	const pruned: string[] = [];
	for (const name of previouslyManaged) {
		if (keepSet.has(name)) continue;
		remove(`${dir}/${name}${suffix}`);
		pruned.push(name);
	}
	writeManifest(manifestPath, keep);
	return { pruned };
}
