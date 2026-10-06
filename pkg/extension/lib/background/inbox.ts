import {
	validateInboxBrowserRequest,
	type ChatFrame,
	type InboxBrowserRequest,
} from "@dg/common";
import { isProtonMailOrigin } from "../features/inbox-proton-observer";
import { sanitizeInboxBrowserResponse } from "../features/inbox-proton";
import { protonOperationDiagnostic } from "../features/inbox-proton-errors";

type RequestFrame = Extract<ChatFrame, { type: "inbox-browser-request" }>;
/** Correlated result before the session transport attaches its private capability token. */
export type InboxResultFrame = Omit<
	Extract<ChatFrame, { type: "inbox-browser-result" }>,
	"token"
>;
type MailTab = { id?: number; url?: string };
/** Injectable tab/MAIN scripting boundary used to select and recheck an authenticated Proton account. */
export type InboxBrowserApi = {
	tabs: {
		query(query: Record<string, unknown>): Promise<MailTab[]>;
		get(id: number): Promise<MailTab>;
	};
	scripting?: {
		executeScript(details: {
			target: { tabId: number };
			world: "MAIN";
			func: (request: InboxBrowserRequest) => Promise<unknown>;
			args: [InboxBrowserRequest];
		}): Promise<Array<{ frameId: number; result?: unknown }>>;
	};
};
function protonTab(tab: MailTab): boolean {
	try {
		return (
			tab.id !== undefined && isProtonMailOrigin(new URL(tab.url ?? "").origin)
		);
	} catch {
		return false;
	}
}
function accountMatches(tab: MailTab, accountHint: string): boolean {
	try {
		return (
			/^\/u\/([^/]+)(?:\/|$)/.exec(new URL(tab.url ?? "").pathname)?.[1] ===
			accountHint
		);
	} catch {
		return false;
	}
}

/** Selects and rechecks an exact Proton tab/account, runs a fixed MAIN operation, and returns sanitized correlated metadata. */
export function createInboxHandler({
	browserApi,
}: {
	browserApi: InboxBrowserApi;
}) {
	return async (frame: RequestFrame): Promise<InboxResultFrame> => {
		const envelope = {
			type: "inbox-browser-result" as const,
			sessionId: frame.sessionId,
			requestId: frame.requestId,
			protocolVersion: frame.protocolVersion,
		};
		let request: InboxBrowserRequest;
		try {
			request = validateInboxBrowserRequest(frame.request);
		} catch {
			return {
				...envelope,
				ok: false,
				error:
					"Unsupported inbox operation or invalid request. Check the reviewed operation and its bounds.",
			};
		}
		if (!browserApi.scripting?.executeScript)
			return {
				...envelope,
				ok: false,
				error:
					"This browser does not support MAIN page execution. Upgrade the browser and extension and grant Proton Mail permissions.",
			};
		let tab: MailTab | undefined;
		try {
			if (request.tabId !== undefined) {
				tab = await browserApi.tabs.get(request.tabId);
				if (
					!protonTab(tab) ||
					(request.accountHint && !accountMatches(tab, request.accountHint))
				)
					return {
						...envelope,
						ok: false,
						error:
							"The selected tab must be an HTTPS Proton Mail tab matching the configured account index.",
					};
			} else {
				const tabs = (await browserApi.tabs.query({}))
					.filter(protonTab)
					.filter(
						(candidate) =>
							!request.accountHint ||
							accountMatches(candidate, request.accountHint),
					);
				if (tabs.length > 1)
					return {
						...envelope,
						ok: false,
						error:
							"Multiple Proton Mail tabs match. Choose an explicit tabId or accountHint (the /u/ account index) in the inbox profile.",
					};
				tab = tabs[0];
			}
			if (!tab || tab.id === undefined)
				return {
					...envelope,
					ok: false,
					error:
						"Open Proton Mail and sign in. Reload its tab after installing the extension, then retry.",
				};
			const selectedAccount = /^\/u\/([^/]+)(?:\/|$)/.exec(
				new URL(tab.url!).pathname,
			)?.[1];
			const pageRequest: InboxBrowserRequest = {
				...request,
				...(request.accountHint === undefined && selectedAccount !== undefined
					? { accountHint: selectedAccount }
					: {}),
			};
			const results = await browserApi.scripting.executeScript({
				target: { tabId: tab.id },
				world: "MAIN",
				args: [pageRequest],
				func: async (input) => {
					// Tab selection precedes injection; bind execution to that account snapshot.
					const origin = globalThis.location?.origin;
					const account = /^\/u\/([^/]+)(?:\/|$)/.exec(
						globalThis.location?.pathname ?? "",
					)?.[1];
					if (
						(origin !== "https://mail.proton.me" &&
							origin !== "https://mail.protonmail.com") ||
						(input.accountHint !== undefined && account !== input.accountHint)
					) {
						return { __dgInboxFailure: true };
					}
					const api = (
						globalThis as typeof globalThis & {
							__dgInboxProtonV1?: (
								request: InboxBrowserRequest,
							) => Promise<unknown>;
						}
					).__dgInboxProtonV1;
					if (!api) return { __dgInboxFailure: true };
					try {
						return await api(input);
					} catch (error) {
						const failure = error as {
							code?: unknown;
							status?: unknown;
						} | null;
						return {
							__dgInboxFailure: true,
							code: failure?.code,
							status: failure?.status,
						};
					}
				},
			});
			const result = results.find((entry) => entry.frameId === 0)?.result;
			if (!result || typeof result !== "object" || "__dgInboxFailure" in result) {
				const diagnostic = result && typeof result === "object"
					? protonOperationDiagnostic(result as Record<string, unknown>)
					: undefined;
				return {
					...envelope,
					ok: false,
					error:
						diagnostic ??
						"Proton page execution failed. Sign in and reload the mail tab so the extension can observe its session; check reviewed settings before retrying.",
				};
			}
			let data;
			try {
				data = sanitizeInboxBrowserResponse(result);
			} catch {
				return {
					...envelope,
					ok: false,
					error:
						"Proton page returned an unsupported response. Reload the mail tab and retry.",
				};
			}
			return { ...envelope, ok: true, data };
		} catch {
			return {
				...envelope,
				ok: false,
				error:
					"Proton tab execution is unavailable. Open or reload the mail tab and grant the extension scripting permissions; upgrade the browser if MAIN execution is unsupported.",
			};
		}
	};
}
