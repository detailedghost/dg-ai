/**
 * Copy a skills tree as data. File contents are never spawned, sourced, or
 * passed to a shell. Symlinks are refused so a link cannot smuggle an
 * executable. Copied files are mode 0644 even when the source was executable.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { filesToInstall } from "../skill-files";

export function skillsInstallDest(
	env: Record<string, string | undefined>,
	home: string = homedir(),
): string {
	if (env.DG_SKILLS_DEST) return env.DG_SKILLS_DEST;
	const root = env.DG_HOME || join(home, ".dg");
	return join(root, "skills");
}

/** Relative path with `/` separators. `pathSep` is injectable so tests can cover Windows. */
export function posixPath(path: string, pathSep: string = sep): string {
	return pathSep === "/" ? path : path.split(pathSep).join("/");
}

/** Regular files under root, relative and posix. Throws when it meets a symlink. */
export function listSkillTreeFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(
					`skills-only install refuses symlink ${posixPath(relative(root, abs))}`,
				);
			}
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			files.push(posixPath(relative(root, abs)));
		}
	};
	walk(root);
	return files;
}

/**
 * Replace each skill directory in dest with the files selected from source.
 * Entries in dest that are not those skill directories are left in place.
 * Returns the relative paths written.
 */
export function installSkillTree(source: string, dest: string): string[] {
	const files = filesToInstall(listSkillTreeFiles(source));
	if (files.length === 0) {
		throw new Error(`no skill instruction files in ${source}`);
	}
	const skillNames = new Set(files.map((file) => file.split("/")[0]));
	mkdirSync(dest, { recursive: true });
	for (const name of skillNames) {
		rmSync(join(dest, name), { recursive: true, force: true });
	}
	for (const file of files) {
		const from = join(source, file);
		const to = join(dest, file);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
		chmodSync(to, 0o644);
	}
	return files;
}

/** Skills-only install writes the thrash persona beside the skills directory. */
export function thrashPersonaDest(skillsDest: string): string {
	return join(dirname(skillsDest), "agents", "thrash.md");
}

/**
 * Copy plugins/dg/agents/thrash.md so a skills-only install can load the
 * persona without the compiled binary. Missing source returns undefined.
 */
export function installThrashPersona(
	repoRoot: string,
	skillsDest: string,
): string | undefined {
	const source = join(repoRoot, "plugins", "dg", "agents", "thrash.md");
	if (!existsSync(source)) return undefined;
	if (lstatSync(source).isSymbolicLink()) {
		throw new Error(
			"skills-only install refuses symlink plugins/dg/agents/thrash.md",
		);
	}
	const dest = thrashPersonaDest(skillsDest);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(source, dest);
	chmodSync(dest, 0o644);
	return dest;
}
