import { DgCliError } from "../errors";
import type { DgToml, PluginEntry } from "../node/dg-toml";
import type { PluginManifest } from "./manifest";

export type PluginConfig = { enabled: boolean; allowRemote: boolean; source?: string; settings: PluginEntry["settings"] };

type EntryWithRemote = PluginEntry & { allow_remote?: unknown };

/** Joins a manifest with its `[plugins.<name>]` section; a remote manifest also needs `allow_remote = true` there. */
export function resolvePluginConfig(config: DgToml, manifest: PluginManifest, file: string): PluginConfig {
	const entry: EntryWithRemote | undefined = config.plugins[manifest.name];
	const allowRemote = manifest.remote && entry?.allow_remote === true;
	if (manifest.remote && !allowRemote)
		throw new DgCliError(
			`dg plugin: ${file}: plugin ${manifest.name} is remote but plugins.${manifest.name}.allow_remote is not true. Next: run dg config set plugins.${manifest.name}.allow_remote true if you trust ${manifest.endpoint}.`,
		);
	return {
		enabled: entry?.enabled ?? false,
		allowRemote,
		...(entry?.source === undefined ? {} : { source: entry.source }),
		settings: entry?.settings ?? {},
	};
}
