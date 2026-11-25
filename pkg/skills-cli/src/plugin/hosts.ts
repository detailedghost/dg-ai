import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { codexDir } from "../hooks/settings/codex";
import { type Env, removeFolder } from "./store";
import { copyTree, listTree } from "./tree";

const MARKER = ".dg-plugin";

function hostSkillRoots(env: Env): string[] {
	const home = env.HOME ?? homedir();
	return [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"), join(codexDir(home, env.CODEX_HOME), "skills")];
}

function ownedBy(dir: string, plugin: string): boolean {
	const marker = join(dir, MARKER);
	return existsSync(marker) && readFileSync(marker, "utf8").trim() === plugin;
}

function skillNames(loaded: string): string[] {
	return readdirSync(loaded, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/** Copies the loaded skills of `plugin` into the Claude and Codex skill folders; a skill dg did not register is never overwritten. */
export function registerOnHosts(plugin: string, loaded: string, env: Env): void {
	const names = existsSync(loaded) ? skillNames(loaded) : [];
	const roots = hostSkillRoots(env);
	for (const root of roots)
		for (const name of names) {
			const target = join(root, name);
			if (existsSync(target) && !ownedBy(target, plugin))
				throw new DgCliError(`dg plugin: ${target} exists and dg did not register it. Next: move or delete it, then enable ${plugin} again.`);
		}
	unregisterFromHosts(plugin, env);
	for (const root of roots)
		for (const name of names) {
			const from = join(loaded, name);
			const target = join(root, name);
			copyTree(from, target, listTree(from));
			writeFileSync(join(target, MARKER), `${plugin}\n`, { mode: 0o644 });
		}
}

/** Removes every host skill folder that `plugin` registered. */
export function unregisterFromHosts(plugin: string, env: Env): void {
	for (const root of hostSkillRoots(env)) {
		if (!existsSync(root)) continue;
		for (const name of skillNames(root)) if (ownedBy(join(root, name), plugin)) removeFolder(join(root, name));
	}
}
