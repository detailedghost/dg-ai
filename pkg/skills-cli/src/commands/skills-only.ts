/**
 * `install --skills-only` copies plugins/dg/skills as instruction files.
 * It does not list GitHub releases or spawn anything inside a skill.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installSkillTree, skillsInstallDest } from "@dg/common/node";

export type SkillsOnlyFlags = {
	cliOnly: boolean;
	local: boolean;
	target: string | undefined;
};

export function assertSkillsOnlyFlags(flags: SkillsOnlyFlags): void {
	if (!flags.cliOnly && !flags.local && flags.target === undefined) return;
	throw new Error(
		"install --skills-only copies skill instruction files and accepts only --repo and --dest",
	);
}

export type SkillsOnlyRequest = {
	repo: string | undefined;
	dest: string | undefined;
	repoRoot: string;
	env?: Record<string, string | undefined>;
	home?: string;
};

export type SkillsOnlyResult = {
	dest: string;
	files: string[];
};

export function runSkillsOnlyInstall(input: SkillsOnlyRequest): SkillsOnlyResult {
	const root = input.repo ? resolve(input.repo) : input.repoRoot;
	const source = join(root, "plugins", "dg", "skills");
	if (!existsSync(source)) {
		throw new Error(
			`no skill instruction files at ${source}. Pass --repo <dg checkout>.`,
		);
	}
	const dest =
		input.dest ||
		skillsInstallDest(input.env ?? process.env, input.home ?? homedir());
	return { dest, files: installSkillTree(source, dest) };
}

export function skillsOnlyReport(result: SkillsOnlyResult): string {
	return [
		...result.files,
		`Installed ${result.files.length} skill files at ${result.dest}.`,
		"Skills-only install: no binaries were fetched and no skill content was executed.",
	].join("\n");
}
