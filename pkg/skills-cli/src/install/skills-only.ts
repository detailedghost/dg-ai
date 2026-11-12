/**
 * `install --skills-only` copies plugins/dg/skills as instruction files.
 * It never spawns anything inside a skill. The install command then fetches only the dg-skills CLI.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	installSkillTree,
	installPersonas,
	listPersonaFiles,
	personasDest,
	skillsInstallDest,
} from "@dg/common/node";

export type SkillsOnlyFlags = {
	cliOnly: boolean;
	agentOnly: boolean;
	local: boolean;
	target: string | undefined;
};

export function assertSkillsOnlyFlags(flags: SkillsOnlyFlags): void {
	if (!flags.cliOnly && !flags.agentOnly && !flags.local && flags.target === undefined) return;
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
	personas: string[];
	personasDir?: string;
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
	const personaNames = listPersonaFiles(root);
	const files = installSkillTree(source, dest);
	if (personaNames.length === 0) return { dest, files, personas: [] };
	const personas = installPersonas(root, personaNames, dest);
	return { dest, files, personas, personasDir: personasDest(dest) };
}

export function skillsOnlyReport(result: SkillsOnlyResult): string {
	return [
		...result.files,
		`Installed ${result.files.length} skill files at ${result.dest}.`,
		...(result.personasDir
			? [`Installed ${result.personas.length} personas at ${result.personasDir}.`]
			: []),
		"Skills-only install: no skill content was executed. Fetching only the dg-skills CLI (no daemon, agent or extension).",
	].join("\n");
}
