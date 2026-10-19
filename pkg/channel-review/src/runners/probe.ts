import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunnerName } from "./types";

export const CLI_TIMEOUT_MS = 60_000;

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

const CLAUDE_CACHE = ".claude/plugins/cache";

const FLAT_SKILL_ROOTS: Record<"codex" | "copilot", string[]> = {
	codex: [".codex/skills", ".agents/skills"],
	copilot: [".copilot/skills"],
};

function hasThrash(fs: SkillFs, skillsDir: string): boolean {
	return fs.exists(join(skillsDir, "thrash", "SKILL.md"));
}

function claudePluginHasThrash(fs: SkillFs, homedir: string): boolean {
	const cache = join(homedir, CLAUDE_CACHE);
	return fs.readdir(cache).some((marketplace) => {
		const plugin = join(cache, marketplace, "dg");
		return fs
			.readdir(plugin)
			.some((version) => hasThrash(fs, join(plugin, version, "skills")));
	});
}

export function thrashInstalled(
	name: Exclude<RunnerName, "grok">,
	homedir: string,
	fs: SkillFs,
): boolean {
	if (name === "claude") return claudePluginHasThrash(fs, homedir);
	return FLAT_SKILL_ROOTS[name].some((dir) => hasThrash(fs, join(homedir, dir)));
}
