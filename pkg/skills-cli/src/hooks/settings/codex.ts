import { isAbsolute, join } from "node:path";
import { EDIT_TOOLS } from "../manifest";
import type { SettingsWriter } from "../types";
import { hookGroupsWriter } from "./claude";

export const CODEX_EDIT_TOOLS = "apply_patch|Edit|Write";

/** Codex home: an absolute CODEX_HOME, else ~/.codex. */
export const codexDir = (home: string, codexHome?: string): string =>
	codexHome && isAbsolute(codexHome) ? codexHome : join(home, ".codex");

export const codexWriter = (
	home: string,
	codexHome?: string,
): SettingsWriter => {
	const dir = codexDir(home, codexHome);
	return hookGroupsWriter(dir, join(dir, "hooks.json"), (def) =>
		def.matcher === EDIT_TOOLS ? CODEX_EDIT_TOOLS : def.matcher,
	);
};
