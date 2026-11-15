import type { ProtonSessionHeaders } from "@dg/inbox";

export type PwResult = { code: number; out: string; err: string };
export type PwRunner = (argv: string[]) => Promise<PwResult>;

/** A refresh request line with no response yet: `[POST] <url>` and nothing after it. */
const REFRESH_PENDING = /^\[POST\] \S*auth\/refresh$/m;
const REFRESH_WAIT_ATTEMPTS = 20;
const REFRESH_WAIT_MS = 250;
/** Proton answers a missing or expired AUTH cookie with one of these. */
const AUTH_REJECTED = new Set([401, 403]);

/** Not a sign-out: the saved session is still being refreshed, so the marker stays. */
export class ProtonRefreshPendingError extends Error {
	constructor() {
		super(
			"Proton Mail is still refreshing its session. The profile may still be signed in. Retry in a moment.",
		);
	}
}

export function pwCommandError(message: string, result: PwResult): Error {
	return new Error(
		`${message} code=${result.code} err=${result.err} out=${result.out}`,
	);
}

function headerValues(text: string, name: string): string[] {
	return [...text.matchAll(new RegExp(`^\\s+${name}:\\s*(.+)$`, "gim"))].map(
		(match) => match[1]?.trim() ?? "",
	);
}

function headerValue(text: string, name: string): string | undefined {
	return headerValues(text, name).at(-1);
}

/** Splits a pw network listing into one block per request line. */
function requestBlocks(listing: string): string[] {
	return listing.split(/^(?=\[[A-Z]+\] )/m);
}

/**
 * True when the request got a response that was not an auth rejection.
 * Pending and failed requests prove nothing about the session.
 */
function authenticated(block: string): boolean {
	const status = /^\[[A-Z]+\] \S+ => \[(\d{3})\]/.exec(block)?.[1];
	return status !== undefined && !AUTH_REJECTED.has(Number(status));
}

/**
 * The Proton page's API request log in a restricted pw session. It reads only
 * the allowlisted x-pm headers and never a cookie.
 */
export function protonRequestLog(
	session: string,
	run: PwRunner,
): {
	reset(): Promise<void>;
	sessionHeaders(): Promise<ProtonSessionHeaders | undefined>;
} {
	/**
	 * Proton's refresh token is one-time. A reload that aborts the page's own
	 * refresh after the server rotated it can leave a dead refresh cookie in the
	 * profile, so wait for that request to finish first, and never reload while
	 * it is still pending.
	 */
	const awaitPendingRefresh = async () => {
		for (let attempt = 0; ; attempt++) {
			const listing = await run([
				session,
				"--raw",
				"network",
				"--filter",
				"auth/refresh",
			]);
			if (listing.code !== 0)
				throw pwCommandError("Could not read the Proton request log.", listing);
			if (!REFRESH_PENDING.test(listing.out)) return;
			if (attempt + 1 >= REFRESH_WAIT_ATTEMPTS) throw new ProtonRefreshPendingError();
			await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS));
		}
	};
	const reset = async () => {
		await awaitPendingRefresh();
		const cleared = await run([
			session,
			"--raw",
			"network",
			"--filter",
			"/api/",
			"--clear",
		]);
		if (cleared.code !== 0)
			throw pwCommandError("Could not reset the Proton request log.", cleared);
		const reloaded = await run([session, "reload"]);
		if (reloaded.code !== 0)
			throw pwCommandError("Could not reset the Proton request log.", reloaded);
	};
	const sessionHeaders = async () => {
		const listing = await run([
			session,
			"--raw",
			"network",
			"--request-headers",
			"--filter",
			"/api/",
		]);
		if (listing.code !== 0)
			throw pwCommandError("Could not read the Proton request headers.", listing);
		const uids = new Set(headerValues(listing.out, "x-pm-uid"));
		if (uids.size > 1) {
			await reset();
			return undefined;
		}
		const accepted = requestBlocks(listing.out)
			.filter(authenticated)
			.join("\n");
		const uid = headerValue(accepted, "x-pm-uid");
		if (!uid) return undefined;
		const appVersion = headerValue(accepted, "x-pm-appversion");
		const locale = headerValue(accepted, "x-pm-locale");
		return {
			uid,
			...(appVersion ? { appVersion } : {}),
			...(locale ? { locale } : {}),
		};
	};
	return { reset, sessionHeaders };
}
