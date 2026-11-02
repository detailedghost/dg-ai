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
const HEADER_WAIT_ATTEMPTS = 20;
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
			"Proton Mail did not make an API request in time. The profile may still be signed in. Retry in a moment.",
		);
	}
}

const SIGNED_OUT_CODES = new Set([
	"auth-expired",
	"mail-tab-navigated",
	"session-unobserved",
]);

export type ProtonPwPage = {
	url(): string | Promise<string>;
	clearObservedHeaders(): Promise<void>;
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

const pause = () => new Promise((resolve) => setTimeout(resolve, HEADER_WAIT_MS));

async function observeHeaders(
	page: ProtonPwPage,
	verify: () => Promise<string | undefined>,
): Promise<ProtonSessionHeaders> {
	for (let attempt = 0; attempt < HEADER_WAIT_ATTEMPTS; attempt++) {
		await verify();
		const headers = await page.observedHeaders();
		if (headers?.uid) return headers;
		await pause();
	}
	throw new ProtonHeadersTimeoutError();
}

async function resolveAccount(
	verify: () => Promise<string | undefined>,
): Promise<string> {
	for (let attempt = 0; attempt < HEADER_WAIT_ATTEMPTS; attempt++) {
		const account = await verify();
		if (account !== undefined) return account;
		await pause();
	}
	throw new ProtonHeadersTimeoutError();
}

function accountOf(url: URL): string | undefined {
	return /^\/u\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
}

export function createPwBrowserRequest(input: {
	dataDir: string;
	openSession(spec: ProtonPwSessionSpec): Promise<ProtonPwSession>;
}): {
	browserRequest(request: InboxBrowserRequest): Promise<InboxBrowserResponse>;
	close(): Promise<void>;
} {
	const { profileDir } = protonProfilePaths(input.dataDir);
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
	) => {
		const url = new URL(await page.url());
		if (!isProtonMailOrigin(url.origin)) {
			await close();
			throw new ProtonSignedOutError();
		}
		const account = accountOf(url);
		for (const want of expected)
			if (want !== undefined && account !== want) throw mismatch();
		return account;
	};
	return {
		close,
		async browserRequest(raw) {
			const request = validateInboxBrowserRequest(raw);
			const { accountHint } = request;
			const { page } = await open(accountHint);
			const verify = () => currentAccount(page, accountHint, pinned);
			const account = await resolveAccount(verify);
			pinned ??= account;
			if (cached && cached.account !== account) throw mismatch();
			let headers = cached?.headers;
			if (!headers) {
				try {
					await page.clearObservedHeaders();
					headers = await observeHeaders(page, verify);
				} catch (error) {
					if (error instanceof ProtonSignedOutError) await close();
					throw error;
				}
				await verify();
				cached = { headers, account };
			}
			const result = (await page.evaluate(PAGE_SCRIPT, {
				request,
				headers,
				account,
			})) as ProtonPageResult;
			if (result && typeof result === "object" && "error" in result) {
				const failure = result.error as { code?: unknown; status?: unknown };
				if (typeof failure.code === "string" && SIGNED_OUT_CODES.has(failure.code))
					throw new ProtonSignedOutError();
				throw new Error(
					protonOperationDiagnostic(failure) ?? "Proton page operation failed.",
				);
			}
			return sanitizeInboxBrowserResponse(validateInboxBrowserResponse(result));
		},
	};
}
