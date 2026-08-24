import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { readConfig, writeConfig } from "../server/config-store";
import { describeError } from "../utils/errors";

export const ASSET_DIRECTORY_CONFIG_KEY = "assetDirectory";

export const DAEMON_ASSET_LEAF = "dg-assets";

export type AssetDirectoryValidation =
	| { ok: true; value: string }
	| { ok: false; reason: string };

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

export function getAssetDirectorySetting(paths: DgPaths): string {
	const persisted = readConfig(paths)[ASSET_DIRECTORY_CONFIG_KEY];
	return typeof persisted === "string" && persisted.length > 0
		? persisted
		: paths.assetsDir;
}

export function getConfiguredAssetDirectory(paths: DgPaths): string {
	return join(getAssetDirectorySetting(paths), DAEMON_ASSET_LEAF);
}

export function setConfiguredAssetDirectory(paths: DgPaths, dir: string): void {
	writeConfig(paths, { [ASSET_DIRECTORY_CONFIG_KEY]: dir });
}
