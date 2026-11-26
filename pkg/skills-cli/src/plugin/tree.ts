import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";

/** Regular files under `root`, as sorted posix paths; a symlink or special file is refused, and a top-level `.git` is skipped. */
export function listTree(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (prefix === "" && entry.name === ".git") continue;
			if (entry.isSymbolicLink())
				throw new DgCliError(`dg plugin: ${rel} is a symlink. Next: remove the symlink from the source; dg plugin installs regular files only.`);
			if (entry.isDirectory()) walk(join(dir, entry.name), rel);
			else if (entry.isFile()) files.push(rel);
			else throw new DgCliError(`dg plugin: ${rel} is not a regular file. Next: remove it from the source.`);
		}
	};
	walk(root, "");
	return files.sort();
}

export function hashTree(root: string, files: string[] = listTree(root)): string {
	const hash = createHash("sha256");
	for (const rel of files) {
		const content = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
		hash.update(`${rel}\0${content}\n`);
	}
	return hash.digest("hex");
}

export function copyTree(from: string, to: string, files: string[], prefix = ""): void {
	for (const rel of files) {
		if (!rel.startsWith(prefix)) continue;
		const target = join(to, rel.slice(prefix.length));
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(from, rel), target);
		chmodSync(target, lstatSync(join(from, rel)).mode & 0o111 ? 0o755 : 0o644);
	}
}
