import { ownedEntries } from "./doctor";
import { HOOKS } from "./manifest";
import { claudeWriter } from "./settings/claude";
import { codexWriter } from "./settings/codex";
import { opencodeWriter } from "./settings/opencode";
import type { HookRuntime, SettingsWriter } from "./types";

const OLD_LAUNCHER = /(?:^|[\\/])dg-skills(?:\.cmd|\.exe)?$/i;

/**
 * Points every enabled hook whose command still runs the removed `dg-skills` launcher at `launcher`,
 * in the Claude, Codex and OpenCode settings. Returns the runtimes it changed; a second run changes nothing.
 */
export async function relaunchHooks(
	launcher: string,
	home: string,
	env: Record<string, string | undefined>,
	warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<HookRuntime[]> {
	const all: Record<HookRuntime, SettingsWriter> = {
		claude: claudeWriter(home),
		codex: codexWriter(home, env.CODEX_HOME),
		opencode: opencodeWriter(home, launcher, env.XDG_CONFIG_HOME),
	};
	const changed: HookRuntime[] = [];
	for (const runtime of Object.keys(all) as HookRuntime[]) {
		try {
			const entries = ownedEntries(runtime, all[runtime]);
			if (!entries.some((entry) => OLD_LAUNCHER.test(entry.launcher))) continue;
			const ids = new Set(entries.map((entry) => entry.id));
			const defs = HOOKS.filter((def) => ids.has(def.id) && def.runtimes.includes(runtime));
			await all[runtime].enable(defs, launcher);
			changed.push(runtime);
		} catch (error) {
			warn(`dg: the ${runtime} hooks still run dg-skills: ${error instanceof Error ? error.message : String(error)}; run dg hooks enable again`);
		}
	}
	return changed;
}
