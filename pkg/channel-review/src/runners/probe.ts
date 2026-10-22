import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudePluginSkillsDirs, realSubdirectories } from "@dg/common/node";
import type { RunnerName } from "./types";

export const CLI_TIMEOUT_MS = 60_000;

export type SkillFs = {
	exists(path: string): boolean;
	/** Names of real subdirectories; symlinks are skipped. */
	readdir(path: string): string[];
};

export const realSkillFs: SkillFs = {
	exists: existsSync,
	readdir: realSubdirectories,
};

const FLAT_SKILL_ROOTS: Record<"codex" | "copilot", string[]> = {
	codex: [".codex/skills", ".agents/skills"],
	copilot: [".copilot/skills", ".agents/skills"],
};

function hasThrash(fs: SkillFs, skillsDir: string): boolean {
	return fs.exists(join(skillsDir, "thrash", "SKILL.md"));
}

function claudePluginHasThrash(fs: SkillFs, homedir: string): boolean {
	return claudePluginSkillsDirs(homedir, fs.readdir, fs.exists).some((dir) =>
		hasThrash(fs, dir),
	);
}

export function thrashInstalled(
	name: Exclude<RunnerName, "grok">,
	homedir: string,
	fs: SkillFs,
): boolean {
	if (name === "claude") return claudePluginHasThrash(fs, homedir);
	return FLAT_SKILL_ROOTS[name].some((dir) => hasThrash(fs, join(homedir, dir)));
}
