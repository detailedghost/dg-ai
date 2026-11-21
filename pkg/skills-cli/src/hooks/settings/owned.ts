import { existsSync, readFileSync } from "node:fs";
import type { HookRuntime, SettingsWriter } from "../types";
import { type JsonObject, readJsonObject } from "./json-file";
import { ownedId, ownedLauncher } from "./marker";

const LIST_LINE = /^const HOOKS = (.*);$/m;

export interface OwnedEntry {
	id: string;
	launcher: string;
}

function commandsIn(doc: JsonObject): string[] {
	const hooks = doc.hooks;
	if (typeof hooks !== "object" || hooks === null) return [];
	return Object.values(hooks).flatMap((groups) =>
		(Array.isArray(groups) ? groups : []).flatMap((group) =>
			Array.isArray(group?.hooks)
				? group.hooks.flatMap((h: { command?: unknown }) =>
						typeof h?.command === "string" ? [h.command] : [],
					)
				: [],
		),
	);
}

export function ownedEntries(
	runtime: HookRuntime,
	writer: SettingsWriter,
): OwnedEntry[] {
	if (!existsSync(writer.file)) return [];
	if (runtime === "opencode") {
		const list = LIST_LINE.exec(readFileSync(writer.file, "utf8"))?.[1];
		const hooks = list
			? (JSON.parse(list) as { id: string; argv: string[] }[])
			: [];
		return hooks.map((h) => ({ id: h.id, launcher: h.argv[0] ?? "" }));
	}
	return commandsIn(readJsonObject(writer.file)).flatMap((command) => {
		const id = ownedId(command);
		const launcher = ownedLauncher(command);
		return id && launcher ? [{ id, launcher }] : [];
	});
}
