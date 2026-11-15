import {
	validateInboxBrowserRequest,
	validateInboxBrowserResponse,
	type InboxBrowserRequest,
	type InboxBrowserResponse,
} from "@dg/common";
import { join } from "node:path";
import type { ProtonPageCall, ProtonPageResult } from "./page-entry";
import { protonOperationDiagnostic } from "./page-errors";
import { sanitizeInboxBrowserResponse } from "./page-operations";
import { isProtonMailOrigin, type ProtonSessionHeaders } from "./page-session";
import { buildProtonPageScript } from "./page-script.macro" with { type: "macro" };

export const PROTON_SIGN_IN_COMMAND = "dg-skills inbox proton sign-in";
export const PROTON_MAIL_URL = "https://mail.proton.me";
export const PROTON_SESSION_NAME = "inbox-proton";

const PAGE_SCRIPT: string = buildProtonPageScript();
/** 40 reads 500ms apart: about 20s for Proton to resume and refresh the session. */
const HEADER_WAIT_ATTEMPTS = 40;
const HEADER_WAIT_MS = 500;

export class ProtonSignedOutError extends Error {
	readonly exitCode = 4;
	constructor() {
		super(
			`Proton Mail is signed out in the pw profile. Run ${PROTON_SIGN_IN_COMMAND}, sign in once, then retry.`,
		);
	}
}

export class ProtonHeadersTimeoutError extends Error {
	constructor() {
		super(
			"Proton Mail did not finish loading a signed-in /u/N mail page with an authenticated API request in time. The profile may still be signed in. Retry in a moment.",
		);
	}
}

const SIGNED_OUT_CODES = new Set([
	"auth-expired",
	"mail-tab-navigated",
	"session-unobserved",
]);

/**
 * Codes the page can recover from on its own: a reload lets the web app
 * refresh its session from the saved refresh cookie, or finish a resume that
 * passed through account.proton.me. A rejected call changed nothing on the
 * server, so one retry is safe for every operation.
 */
const REFRESHABLE_CODES = new Set(["auth-expired", "mail-tab-navigated"]);

export type ProtonPwPage = {
	url(): string | Promise<string>;
	/** Empties the request log and reloads, so the page makes fresh requests. */
	clearObservedHeaders(): Promise<void>;
	/** Headers from an API request whose response was not a 401 or 403. */
	observedHeaders():
		| ProtonSessionHeaders
		| undefined
		| Promise<ProtonSessionHeaders | undefined>;
	evaluate(script: string, call: ProtonPageCall): Promise<unknown>;
};

export type ProtonPwSession = {
	page: ProtonPwPage;
	close(): Promise<void>;
};

export type ProtonPwSessionSpec = {
	name: string;
	profileDir: string;
	headless: boolean;
	url?: string;
};

export function protonProfilePaths(dataDir: string): {
	profileDir: string;
	markerPath: string;
} {
	const inboxDir = join(dataDir, "inbox");
	return {
		profileDir: join(inboxDir, "proton-profile"),
		markerPath: join(inboxDir, "proton-signed-in.json"),
	};
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** The page is on another origin, such as account.proton.me during Proton's session resume. */
const OFF_ORIGIN = Symbol("off-origin");
type AccountRead = string | undefined | typeof OFF_ORIGIN;

/**
 * Proton's session resume can pass through account.proton.me and back, so an
 * off-origin read only counts as signed out when it lasts for the whole wait.
 */
function waitFailure(last: AccountRead): Error {
	return last === OFF_ORIGIN
		? new ProtonSignedOutError()
		: new ProtonHeadersTimeoutError();
}

async function resolveAccount(
	read: () => Promise<AccountRead>,
	sleep: Sleep,
): Promise<string> {
	let last: AccountRead;
	for (let attempt = 0; attempt < HEADER_WAIT_ATTEMPTS; attempt++) {
		last = await read();
		if (typeof last === "string") return last;
		await sleep(HEADER_WAIT_MS);
	}
	throw waitFailure(last);
}

/**
 * Waits for an authenticated API response. A fresh browser launch has no
 * AUTH cookie, because Proton sets it without an expiry and Chromium drops
 * session cookies on restart, so the page's first requests get 401 until the
 * web app refreshes the session with its saved refresh cookie.
 */
async function observeHeaders(
	page: ProtonPwPage,
	read: () => Promise<AccountRead>,
	sleep: Sleep,
): Promise<ProtonSessionHeaders> {
	let last: AccountRead;
	for (let attempt = 0; attempt < HEADER_WAIT_ATTEMPTS; attempt++) {
		last = await read();
		if (last !== OFF_ORIGIN) {
			const headers = await page.observedHeaders();
			if (headers?.uid) return headers;
		}
		await sleep(HEADER_WAIT_MS);
	}
	throw waitFailure(last);
}

function accountOf(url: URL): string | undefined {
	return /^\/u\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
}

export function createPwBrowserRequest(input: {
	dataDir: string;
	openSession(spec: ProtonPwSessionSpec): Promise<ProtonPwSession>;
	sleep?: Sleep;
}): {
	browserRequest(request: InboxBrowserRequest): Promise<InboxBrowserResponse>;
	close(): Promise<void>;
} {
	const { profileDir } = protonProfilePaths(input.dataDir);
	const sleep = input.sleep ?? defaultSleep;
	let opened: Promise<ProtonPwSession> | undefined;
	const open = (accountHint: string | undefined) =>
		(opened ??= input.openSession({
			name: PROTON_SESSION_NAME,
			profileDir,
			headless: true,
			...(accountHint === undefined
				? {}
				: { url: `${PROTON_MAIL_URL}/u/${accountHint}` }),
		}));
	let cached: { headers: ProtonSessionHeaders; account: string } | undefined;
	let pinned: string | undefined;
	const close = async () => {
		const pending = opened;
		opened = undefined;
		cached = undefined;
		pinned = undefined;
		await pending?.then(
			(session) => session.close(),
			() => undefined,
		);
	};
	const mismatch = () => {
		cached = undefined;
		return new Error(
			protonOperationDiagnostic({ code: "account-mismatch" }) ??
				"Proton account mismatch.",
		);
	};
	const currentAccount = async (
		page: ProtonPwPage,
		...expected: (string | undefined)[]
	): Promise<AccountRead> => {
		const url = new URL(await page.url());
		if (!isProtonMailOrigin(url.origin)) return OFF_ORIGIN;
		const account = accountOf(url);
		// Proton's resume passes through mail paths with no /u/N, such as /login
		// or /inbox, before it settles; only a different /u/N is a mismatch.
		if (account === undefined) return undefined;
		for (const want of expected)
			if (want !== undefined && account !== want) throw mismatch();
		return account;
	};
	const closeIfSignedOut = async (error: unknown) => {
		if (error instanceof ProtonSignedOutError) await close();
		return error;
	};
	return {
		close,
		async browserRequest(raw) {
			const request = validateInboxBrowserRequest(raw);
			const { accountHint } = request;
			const { page } = await open(accountHint);
			const read = () => currentAccount(page, accountHint, pinned);
			let refreshed = false;
			for (;;) {
				let account: string;
				let headers: ProtonSessionHeaders;
				try {
					account = await resolveAccount(read, sleep);
					pinned ??= account;
					if (cached && cached.account !== account) throw mismatch();
					if (cached) headers = cached.headers;
					else {
						await page.clearObservedHeaders();
						headers = await observeHeaders(page, read, sleep);
						await resolveAccount(read, sleep);
						cached = { headers, account };
					}
				} catch (error) {
					throw await closeIfSignedOut(error);
				}
				const result = (await page.evaluate(PAGE_SCRIPT, {
					request,
					headers,
					account,
				})) as ProtonPageResult;
				if (result && typeof result === "object" && "error" in result) {
					const failure = result.error as { code?: unknown; status?: unknown };
					const code = String(failure.code);
					if (!refreshed && REFRESHABLE_CODES.has(code)) {
						refreshed = true;
						cached = undefined;
						continue;
					}
					if (SIGNED_OUT_CODES.has(code))
						throw await closeIfSignedOut(new ProtonSignedOutError());
					throw new Error(
						protonOperationDiagnostic(failure) ??
							"Proton page operation failed.",
					);
				}
				return sanitizeInboxBrowserResponse(validateInboxBrowserResponse(result));
			}
		},
	};
}
