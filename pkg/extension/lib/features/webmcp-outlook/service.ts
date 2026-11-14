import { createConcurrencyLimit } from "@dg/common";
import type { OutlookSessionHeaders } from "./observer";

type PageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type OwaItem = Record<string, unknown>;

export const OUTLOOK_STILL_LOADING = "Outlook is still loading; retry.";
export const OUTLOOK_CANCELED = "The Outlook tool call was canceled.";
export const OUTLOOK_ACCOUNT_CHANGED = "The Outlook account of this tab changed; retry.";
const HEADERS_WAIT_MS = 10_000;
const HEADERS_POLL_MS = 100;
const IN_FLIGHT = 4;
const REFUSED = new Set([401, 429, 440]);
const CODE = /^[A-Za-z]{1,80}$/;

const ACCOUNT_PATH = /^\/[a-z]+\/(\d+)(?:\/|$)/;

/** The service.svc path of the page's own account: /<app>/<n>/ (mail, calendar and the other routes) posts to /owa/<n>/, and outlook.live.com with no index posts to /owa/0/. */
export function servicePathOf(location: Pick<Location, "hostname" | "pathname">): string {
	const index = ACCOUNT_PATH.exec(location.pathname)?.[1] ?? (location.hostname === "outlook.live.com" ? "0" : undefined);
	return index === undefined ? "/owa/service.svc" : `/owa/${index}/service.svc`;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const owaSucceeded = (item: OwaItem | undefined) => item?.ResponseClass === "Success";

/** The response code of a failed response message, or "unknown error" when it is not a plain code word. */
export function owaErrorCode(item: OwaItem | undefined): string {
	const code = item?.ResponseCode;
	return typeof code === "string" && CODE.test(code) ? code : "unknown error";
}

/** OWA service.svc client that runs in the page realm with the session headers of the page's own account endpoint; at most 4 calls in flight. */
export function createOwaService({
	location,
	fetch,
	headers,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
	location: Pick<Location, "origin" | "hostname" | "pathname">;
	fetch: PageFetch;
	headers: (servicePath: string) => OutlookSessionHeaders | undefined;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}) {
	const limit = createConcurrencyLimit(IN_FLIGHT);

	const live = (signal?: AbortSignal) => {
		if (signal?.aborted) throw new Error(OUTLOOK_CANCELED);
	};

	async function session(path: string, signal?: AbortSignal): Promise<OutlookSessionHeaders> {
		const start = now();
		for (;;) {
			live(signal);
			const held = headers(path);
			if (held) return held;
			if (now() - start >= HEADERS_WAIT_MS) throw new Error(OUTLOOK_STILL_LOADING);
			await sleep(HEADERS_POLL_MS);
		}
	}

	async function send(path: string, action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<OwaItem[]> {
		const held = await session(path, signal);
		live(signal);
		if (servicePathOf(location) !== path) throw new Error(OUTLOOK_ACCOUNT_CHANGED);
		let response: Response;
		try {
			response = await fetch(`${location.origin}${path}?action=${encodeURIComponent(action)}&app=Mail`, {
				method: "POST",
				credentials: "include",
				signal,
				headers: {
					...held,
					action,
					"content-type": "application/json; charset=utf-8",
					"x-req-source": "Mail",
				},
				body: JSON.stringify({
					__type: `${action}JsonRequest:#Exchange`,
					Header: { __type: "JsonRequestHeaders:#Exchange", RequestServerVersion: "Exchange2016" },
					Body: body,
				}),
			});
		} catch {
			live(signal);
			throw new Error("Outlook did not answer.");
		}
		if (REFUSED.has(response.status)) throw new Error(`Outlook refused the request (${response.status})`);
		if (!response.ok) throw new Error(`Outlook returned an error (${response.status})`);
		const parsed = await response.json().catch(() => undefined);
		const items = record(record(record(parsed)?.Body)?.ResponseMessages)?.Items;
		if (!Array.isArray(items) || items.length === 0)
			throw new Error("Outlook sent a reply this tool does not understand.");
		const messages = items.map((item) => record(item) ?? {});
		if (!messages.some(owaSucceeded)) throw new Error(`Outlook could not run ${action} (${owaErrorCode(messages[0])}).`);
		return messages;
	}

	return {
		call(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<OwaItem[]> {
			const path = servicePathOf(location);
			return limit(() => send(path, action, body, signal));
		},
	};
}

export type OwaService = ReturnType<typeof createOwaService>;
