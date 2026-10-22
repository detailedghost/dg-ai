/** Shared directory-tree copy helpers for sync targets that materialize a skill tree as data. */

import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rewriteScratchPaths } from "./scratch-rewrite";

export function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

export function readlinkSafe(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

/** Copy every regular file under `from` into `to`; symlinks are skipped, never followed. */
export function copyTree(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const f = join(from, entry.name);
		const t = join(to, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) copyTree(f, t);
		else if (entry.isFile()) {
			mkdirSync(dirname(t), { recursive: true });
			copyFileSync(f, t);
		}
	}
}

function isProbablyText(buf: Buffer): boolean {
	return !buf.includes(0);
}

/** Rewrite scratch/state paths in every text file under `dir`, in place; binary files are left untouched. */
export function rewriteTreeScratchPaths(dir: string, env: NodeJS.ProcessEnv = process.env): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			rewriteTreeScratchPaths(full, env);
			continue;
		}
		if (!entry.isFile()) continue;
		const buf = readFileSync(full);
		if (!isProbablyText(buf)) continue;
		const before = buf.toString("utf8");
		const after = rewriteScratchPaths(before, env);
		if (after !== before) writeFileSync(full, after);
	}
}
