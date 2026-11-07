import { CHAT_WS_PATH, DG_CHROME_EXTENSION_ORIGIN } from "@dg/common";
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

export function isTrustedExtensionOrigin(origin: string | null): boolean {
	if (!isExtensionOrigin(origin)) return false;
	return (
		new URL(origin as string).protocol !== "chrome-extension:" ||
		origin === DG_CHROME_EXTENSION_ORIGIN
	);
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

const LOOPBACK_PAGE_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function isLocalPageOrigin(origin: string | null, port: number): boolean {
	if (!origin) return false;
	try {
		const url = new URL(origin);
		return (
			url.protocol === "http:" &&
			LOOPBACK_PAGE_HOSTS.has(url.hostname) &&
			url.port === String(port)
		);
	} catch {
		return false;
	}
}

const BEARER_PREFIX = "Bearer ";

export function bearerToken(req: Request): string | undefined {
	const authorization = req.headers.get("authorization");
	return authorization?.startsWith(BEARER_PREFIX)
		? authorization.slice(BEARER_PREFIX.length)
		: undefined;
}

function presentedToken(req: Request, url: URL): string | null {
	const bearer = bearerToken(req);
	if (bearer !== undefined) return bearer;
	return url.pathname === CHAT_WS_PATH ? url.searchParams.get("token") : null;
}

/** Browsers omit Origin on same-origin GET, so a bare token also claims a local page. */
export function claimsLocalPage(req: Request, url: URL, port: number): boolean {
	const origin = req.headers.get("origin");
	return origin === null
		? presentedToken(req, url) !== null
		: isLocalPageOrigin(origin, port);
}

export function requireLocalPageOrigin(
	req: Request,
	url: URL,
	port: number,
	isLiveToken: (token: string) => boolean,
): Response | undefined {
	const origin = req.headers.get("origin");
	if (origin !== null && !isLocalPageOrigin(origin, port)) {
		return new Response("refused", {
			status: 400,
			headers: { "X-Content-Type-Options": "nosniff" },
		});
	}
	const token = presentedToken(req, url);
	if (token === null || !isLiveToken(token)) {
		return new Response("refused", {
			status: 403,
			headers: { "X-Content-Type-Options": "nosniff" },
		});
	}
	return undefined;
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
