import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunnerName } from "./types";

export const CLI_TIMEOUT_MS = 60_000;

const WALK_DEPTH = 6;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "skills"]);

export type SkillFs = {
	exists(path: string): boolean;
	/** Names of real subdirectories; symlinks are skipped. */
	readdir(path: string): string[];
};

export const realSkillFs: SkillFs = {
	exists: existsSync,
	readdir: (path) => {
		try {
			return readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	},
};

const SKILL_ROOTS: Record<RunnerName, { dir: string; nested: boolean }[]> = {
	claude: [
		{ dir: ".claude/skills", nested: false },
		{ dir: ".claude/plugins", nested: true },
	],
	codex: [
		{ dir: ".codex/skills", nested: false },
		{ dir: ".agents/skills", nested: false },
	],
	copilot: [
		{ dir: ".copilot/skills", nested: false },
		{ dir: ".claude/skills", nested: false },
	],
};

function hasThrash(fs: SkillFs, skillsDir: string): boolean {
	return fs.exists(join(skillsDir, "thrash", "SKILL.md"));
}

function nestedHasThrash(fs: SkillFs, dir: string, depth: number): boolean {
	if (hasThrash(fs, join(dir, "skills"))) return true;
	if (depth === 0) return false;
	return fs
		.readdir(dir)
		.filter((name) => !SKIPPED_DIRECTORIES.has(name))
		.some((name) => nestedHasThrash(fs, join(dir, name), depth - 1));
}

export function thrashInstalled(
	name: RunnerName,
	homedir: string,
	fs: SkillFs,
): boolean {
	return SKILL_ROOTS[name].some(({ dir, nested }) =>
		nested
			? nestedHasThrash(fs, join(homedir, dir), WALK_DEPTH)
			: hasThrash(fs, join(homedir, dir)),
	);
}
