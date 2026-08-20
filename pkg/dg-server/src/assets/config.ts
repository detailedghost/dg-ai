/** Daemon-authoritative asset directory, persisted to the shared config.json. */
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { readConfig, writeConfig } from "../server/config-store";

export const ASSET_DIRECTORY_CONFIG_KEY = "assetDirectory";

export const DAEMON_ASSET_LEAF = "dg-assets";

export type AssetDirectoryValidation =
	| { ok: true; value: string }
	| { ok: false; reason: string };

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Accepts only an absolute, existing, writable, non-symlink directory, and creates nothing. */
export function validateAssetDirectory(dir: string): AssetDirectoryValidation {
	if (!isAbsolute(dir)) {
		return { ok: false, reason: `${dir} is not an absolute path` };
	}
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(dir);
	} catch (err) {
		return { ok: false, reason: `not a directory: ${describeError(err)}` };
	}
	if (info.isSymbolicLink()) {
		return { ok: false, reason: `${dir} is a symbolic link` };
	}
	if (!info.isDirectory()) {
		return { ok: false, reason: `${dir} is not a directory` };
	}
	try {
		accessSync(dir, constants.W_OK);
	} catch (err) {
		return { ok: false, reason: `not writable: ${describeError(err)}` };
	}
	return { ok: true, value: dir };
}

/** The value the settings field shows and config-set persists: the parent, not the leaf assets land in. */
export function getAssetDirectorySetting(paths: DgPaths): string {
	const persisted = readConfig(paths)[ASSET_DIRECTORY_CONFIG_KEY];
	return typeof persisted === "string" && persisted.length > 0
		? persisted
		: paths.assetsDir;
}

/** Where assets actually land. Appending the leaf on READ is also the migration for values persisted before the leaf existed. */
export function getConfiguredAssetDirectory(paths: DgPaths): string {
	return join(getAssetDirectorySetting(paths), DAEMON_ASSET_LEAF);
}

export function setConfiguredAssetDirectory(paths: DgPaths, dir: string): void {
	writeConfig(paths, { [ASSET_DIRECTORY_CONFIG_KEY]: dir });
}
