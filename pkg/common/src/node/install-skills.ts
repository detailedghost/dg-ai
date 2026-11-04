/**
 * Copy a skills tree as data. File contents are never spawned, sourced, or
 * passed to a shell. Symlinks are refused so a link cannot smuggle an
 * executable. Copied files are mode 0644 even when the source was executable.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
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

export const RETIRED_SKILLS = ["phone-friend", "teach", "wait-what"];

/** SHA-256 of every SKILL.md dg shipped for a retired name that another plugin now provides. */
export const RETIRED_SKILL_HASHES: Record<string, string[]> = {
	teach: [
		"b32cdde3ab7f7239d157dd2225c984e48c02aa981cb962b42cdda5cdd1c4dc68",
		"bb06ec5c6763216f76a7af5fbbea839476008747740ded023d285a5afddbd3c9",
		"f5c44555744159f345cfdd1ab1eede4977f06cf31b911edffc48e35747b313a9",
		"d173128190d9450759d3ca5a261987448e176665fabb9cd7a0ffba4d4f006020",
	],
	"wait-what": [
		"3ff07fa007759e417d95c4885ed333a84119cc0d621f7e3d805ca46b6ffb3dd6",
		"6f40fe8148898ee8cb306b8fec3f8f674ee346f5ef54bf9f2d2790e43e1e1f4a",
		"9b0cee4706ad7eb61490d3cb997b1dad7cfebd2dc974e4735b5a2fb65a1bcb3e",
		"f923f0a108954acb787d4b9d331bc44525ab70721df0e00e719284007a773bd0",
	],
};

function isRemovableRetired(dest: string, name: string): boolean {
	const known = RETIRED_SKILL_HASHES[name];
	if (!known) return true;
	const skill = join(dest, name, "SKILL.md");
	if (!existsSync(skill)) return false;
	return known.includes(createHash("sha256").update(readFileSync(skill)).digest("hex"));
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
	for (const name of RETIRED_SKILLS) {
		if (isRemovableRetired(dest, name)) rmSync(join(dest, name), { recursive: true, force: true });
	}
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

/** Skills-only install writes the personas beside the skills directory. */
export function personasDest(skillsDest: string): string {
	return join(dirname(skillsDest), "agents");
}

/** Persona files in plugins/dg/agents. Throws on a symlink so a bad source fails before any write. */
export function listPersonaFiles(repoRoot: string): string[] {
	const source = join(repoRoot, "plugins", "dg", "agents");
	if (!existsSync(source)) return [];
	const names: string[] = [];
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) {
			throw new Error(
				`skills-only install refuses symlink plugins/dg/agents/${entry.name}`,
			);
		}
		if (entry.isFile()) names.push(entry.name);
	}
	return names.sort();
}

/**
 * Copy every persona so a skills-only install can load them without the
 * compiled binary. A link at a destination is replaced, never followed.
 */
export function installPersonas(
	repoRoot: string,
	names: string[],
	skillsDest: string,
): string[] {
	const destDir = personasDest(skillsDest);
	mkdirSync(destDir, { recursive: true });
	for (const name of names) {
		const to = join(destDir, name);
		rmSync(to, { force: true });
		copyFileSync(join(repoRoot, "plugins", "dg", "agents", name), to);
		chmodSync(to, 0o644);
	}
	return names;
}
