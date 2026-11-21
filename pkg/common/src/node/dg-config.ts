import { resolveDgPaths } from "./dg-paths";
import { mergeDgToml, readDgToml } from "./dg-toml";
import { migrateToTomlSync } from "./dg-toml-migrate";
import { assertNotBlocked } from "./layout";

export type DgConfig = Record<string, unknown>;
type ConfigEnv = Record<string, string | undefined>;

function hooksOnly(hooks: Record<string, unknown>): DgConfig {
	return Object.keys(hooks).length ? { hooks } : {};
}

/** The [hooks] table of config.toml; an invalid file throws so a write never clobbers it. */
export function readDgConfig(env: ConfigEnv = process.env): DgConfig {
	return hooksOnly(readDgToml(env).hooks);
}

/** Deep-merges the patch into config.toml, moving the old config files in first. */
export function writeDgConfig(patch: DgConfig, env: ConfigEnv = process.env): DgConfig {
	const paths = resolveDgPaths({ env });
	assertNotBlocked(paths, "config");
	migrateToTomlSync(paths, { env });
	return hooksOnly(mergeDgToml(patch, env).hooks);
}
