import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDgToml, resolveDgPaths } from "@dg/common/node";
import type { PluginManifest } from "@dg/common/plugins/manifest";
import { isApproved, readRecord } from "../plugin/store";
import type { HookEnv } from "./types";

export type ExternalHookPlugin = { manifest: PluginManifest; pluginDir: string; allowRemote: boolean };

const PLUGINS_SECTION = /^[ \t]*\[[ \t]*plugins[ \t]*[.\]]/m;

/** Reads config.toml as text so a hook run with no plugins never loads the TOML parser or the plugin code. */
export function hasConfiguredPlugins(env: HookEnv): boolean {
	const { configTomlPath } = resolveDgPaths({ env });
	return existsSync(configTomlPath) && PLUGINS_SECTION.test(readFileSync(configTomlPath, "utf8"));
}

function isApprovedPlugin(id: string, env: HookEnv): boolean {
	try {
		return isApproved(readRecord(id, env), env);
	} catch {
		return false;
	}
}

/** The enabled external hook plugin named `id`, or undefined when it is not configured, disabled, or not a hook. */
export async function resolveExternalHook(id: string, env: HookEnv): Promise<ExternalHookPlugin | undefined> {
	const config = readDgToml(env);
	if (config.plugins[id]?.enabled !== true) return undefined;
	const [{ DgCliError }, { parseManifest }, { resolvePluginConfig }] = await Promise.all([
		import("@dg/common/errors"),
		import("@dg/common/plugins/manifest"),
		import("@dg/common/plugins/config"),
	]);
	const pluginDir = join(resolveDgPaths({ env }).dataDir, "plugins", id);
	const file = join(pluginDir, "src", "plugin.toml");
	if (!existsSync(file))
		throw new DgCliError(`dg hooks: ${file}: plugin ${id} is enabled but has no src/plugin.toml. Next: run dg plugin add, or set plugins.${id}.enabled false.`);
	const manifest = parseManifest(readFileSync(file, "utf8"), file);
	if (manifest.name !== id)
		throw new DgCliError(`dg hooks: ${file}: plugin.toml names ${manifest.name}, not ${id}. Next: fix name in plugin.toml.`);
	if (!isApprovedPlugin(id, env))
		throw new DgCliError(`dg hooks: plugin ${id} is not approved. Next: review it, then run dg plugin verify ${id} --approve.`);
	if (manifest.kind !== "hook" || "builtin" in manifest.entry) return undefined;
	const { allowRemote } = resolvePluginConfig(config, manifest, file);
	return { manifest, pluginDir, allowRemote };
}
