import type { DgPaths } from "@dg/common/node";
import { readConfig, writeConfig } from "./config-store";

const EXTENSION_SCHEME_RE = /^[a-z][a-z0-9.+-]*-extension:$/i;

/** /ws requires an extension-scheme Origin — chrome-extension:, moz-extension:, etc. */
export function isExtensionOrigin(origin: string | null): boolean {
	if (!origin) return false;
	try {
		return EXTENSION_SCHEME_RE.test(new URL(origin).protocol);
	} catch {
		return false;
	}
}

/** /cli rejects any browser Origin — a real webpage always sends http(s). */
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

/**
 * Trust-on-first-use: the first extension-scheme origin to complete a
 * token-authenticated handshake is pinned; later mismatches are refused.
 * Origin is attacker-controlled from any local non-browser process, so this
 * is defense in depth only — the token is the sole access control.
 */
export function checkPinnedOrigin(paths: DgPaths, origin: string): boolean {
	const pinned = readConfig(paths)[PINNED_ORIGIN_KEY];
	return pinned === undefined || pinned === origin;
}

/** Commit the pin only once a real capability has been proven for this origin. */
export function pinOriginIfUnset(paths: DgPaths, origin: string): void {
	const config = readConfig(paths);
	if (config[PINNED_ORIGIN_KEY] === undefined) {
		writeConfig(paths, { [PINNED_ORIGIN_KEY]: origin });
	}
}
