import { createConcurrencyLimit } from "@dg/common";
import type { OutlookSessionHeaders } from "./observer";

type PageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type OwaItem = Record<string, unknown>;

export const OUTLOOK_STILL_LOADING = "Outlook is still loading; retry.";
export const OUTLOOK_CANCELED = "The Outlook tool call was canceled.";
const HEADERS_WAIT_MS = 10_000;
const HEADERS_POLL_MS = 100;
const IN_FLIGHT = 4;
const REFUSED = new Set([401, 429, 440]);
const CODE = /^[A-Za-z]{1,80}$/;

const servicePath = (origin: string) =>
	new URL(origin).hostname === "outlook.live.com" ? "/owa/0/service.svc" : "/owa/service.svc";

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** OWA service.svc client that runs in the page realm with the captured session headers; at most 4 calls in flight. */
export function createOwaService({
	origin,
	fetch,
	headers,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
	origin: string;
	fetch: PageFetch;
	headers: () => OutlookSessionHeaders | undefined;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}) {
	const limit = createConcurrencyLimit(IN_FLIGHT);

	const live = (signal?: AbortSignal) => {
		if (signal?.aborted) throw new Error(OUTLOOK_CANCELED);
	};

	async function session(signal?: AbortSignal): Promise<OutlookSessionHeaders> {
		const start = now();
		for (;;) {
			live(signal);
			const held = headers();
			if (held) return held;
			if (now() - start >= HEADERS_WAIT_MS) throw new Error(OUTLOOK_STILL_LOADING);
			await sleep(HEADERS_POLL_MS);
		}
	}

	async function send(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<OwaItem[]> {
		const held = await session(signal);
		live(signal);
		let response: Response;
		try {
			response = await fetch(`${origin}${servicePath(origin)}?action=${encodeURIComponent(action)}&app=Mail`, {
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
		if (!Array.isArray(items)) throw new Error("Outlook sent a reply this tool does not understand.");
		for (const item of items) {
			if (record(item)?.ResponseClass === "Success") continue;
			const code = record(item)?.ResponseCode;
			throw new Error(`Outlook could not run ${action} (${typeof code === "string" && CODE.test(code) ? code : "unknown error"}).`);
		}
		return items as OwaItem[];
	}

	return {
		call: (action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<OwaItem[]> =>
			limit(() => send(action, body, signal)),
	};
}

export type OwaService = ReturnType<typeof createOwaService>;
