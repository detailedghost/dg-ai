import type { DgPaths } from "@dg/common/node";
import { readConfig, writeConfig } from "./config-store";

const EXTENSION_SCHEME_RE = /^[a-z][a-z0-9.+-]*-extension:$/i;

export function isExtensionOrigin(origin: string | null): boolean {
	if (!origin) return false;
	try {
		return EXTENSION_SCHEME_RE.test(new URL(origin).protocol);
	} catch {
		return false;
	}
}

export function isBrowserOrigin(origin: string | null): boolean {
	if (!origin) return false;
	try {
		const scheme = new URL(origin).protocol;
		return scheme === "http:" || scheme === "https:";
	} catch {
		return false;
	}
}

const PINNED_ORIGIN_KEY = "pinnedOrigin";

export function checkPinnedOrigin(paths: DgPaths, origin: string): boolean {
	const pinned = readConfig(paths)[PINNED_ORIGIN_KEY];
	return pinned === undefined || pinned === origin;
}

export function pinOriginIfUnset(paths: DgPaths, origin: string): void {
	const config = readConfig(paths);
	if (config[PINNED_ORIGIN_KEY] === undefined) {
		writeConfig(paths, { [PINNED_ORIGIN_KEY]: origin });
	}
}

export function getPinnedOrigin(paths: DgPaths): string | undefined {
	const pinned = readConfig(paths)[PINNED_ORIGIN_KEY];
	return typeof pinned === "string" ? pinned : undefined;
}

export function clearPinnedOrigin(paths: DgPaths): void {
	writeConfig(paths, { [PINNED_ORIGIN_KEY]: undefined });
}
