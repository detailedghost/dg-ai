import {
	isPwExtWebUrl,
	isPwExtWriteVerb,
	PW_EXT_MAX_TEXT_CHARS,
	type PwExtRequest,
	type PwExtResponse,
	type PwExtVerb,
	redactText,
	validatePwExtRequest,
} from "@dg/common";
import {
	type PwExtPageAction,
	type PwExtPageResult,
	pwExtPageAction,
} from "@/lib/features/pw-ext-page";
import { isProtonMailOrigin } from "@/lib/features/inbox-proton-observer";
import { fitPreviewDataUrl } from "./proto";

type Tab = {
	id?: number;
	windowId?: number;
	url?: string;
	title?: string;
	active?: boolean;
};

/** Promise-based Chromium MV3 surface the handler needs. */
export type PwExtBrowserApi = {
	windows: {
		getLastFocused(options: {
			windowTypes: ["normal"];
		}): Promise<{ id?: number }>;
	};
	tabs: {
		query(query: { active?: boolean; windowId?: number }): Promise<Tab[]>;
		get(tabId: number): Promise<Tab>;
		create(props: {
			url: string;
			windowId?: number;
			active: boolean;
		}): Promise<Tab>;
		captureVisibleTab(
			windowId: number,
			options: { format: "jpeg"; quality: number },
		): Promise<string>;
	};
	scripting: {
		executeScript(details: {
			target: { tabId: number };
			func: (action: PwExtPageAction) => PwExtPageResult;
			args: [PwExtPageAction];
		}): Promise<Array<{ result?: unknown }>>;
	};
};

/** What the human sees before one call runs. */
export type PwExtApprovalPrompt = {
	verb: PwExtVerb;
	write: boolean;
	tabTitle: string;
	tabUrl: string;
	detail?: string;
};

export type PwExtResult =
	| { ok: true; data: PwExtResponse }
	| { ok: false; error: string };

export const PW_EXT_BLOCKED_ERROR =
	"pw --ext does not read or change browser settings pages, extension pages, or other non-web pages. Switch to a web page tab and retry.";
const STORE_HOSTS = new Set([
	"chromewebstore.google.com",
	"chrome.google.com",
	"microsoftedge.microsoft.com",
]);
export const PW_EXT_MAILBOX_ERROR =
	"pw --ext does not read or change the signed-in Proton Mail tab. Use dg-skills inbox.";
const MAX_TABS = 200;
const JPEG_QUALITY = 70;

function allowedPage(url: string | undefined): url is string {
	if (!url || !isPwExtWebUrl(url)) return false;
	return !STORE_HOSTS.has(new URL(url).hostname);
}

function mailbox(url: string | undefined): boolean {
	try {
		return isProtonMailOrigin(new URL(url ?? "").origin);
	} catch {
		return false;
	}
}

function cap(text: string): string {
	const marker = "\n[truncated]";
	return text.length > PW_EXT_MAX_TEXT_CHARS
		? `${text.slice(0, PW_EXT_MAX_TEXT_CHARS - marker.length)}${marker}`
		: text;
}

function clean(text: string): string {
	return cap(redactText(text));
}

function shownUrl(tab: Tab): string {
	if (!allowedPage(tab.url)) return "(browser page)";
	return mailbox(tab.url) ? "(protected mailbox)" : redactText(tab.url);
}

function shownTitle(tab: Tab): string {
	if (!allowedPage(tab.url) || mailbox(tab.url)) return "";
	return redactText(tab.title ?? "");
}

function pageLines(tab: Tab): string[] {
	const title = shownTitle(tab);
	return [
		"### Page",
		`- Page URL: ${shownUrl(tab)}`,
		...(title ? [`- Page Title: ${title}`] : []),
	];
}

function detailFor(request: PwExtRequest): string | undefined {
	switch (request.verb) {
		case "open":
			return `Open ${request.url} in a new tab`;
		case "click":
			return `Click ${request.target}`;
		case "fill":
			return `Fill ${request.target} with "${(request.value ?? "").slice(0, 200)}"`;
		default:
			return undefined;
	}
}

function defaultIsChromium(): boolean {
	const runtime = (
		globalThis as { browser?: { runtime?: { getBrowserInfo?: unknown } } }
	).browser?.runtime;
	return typeof runtime?.getBrowserInfo !== "function";
}

/** Runs one approved pw --ext verb against the active tab of the last focused window. */
export function createPwExtHandler({
	browserApi: api,
	approve,
	isChromium = defaultIsChromium,
}: {
	browserApi: PwExtBrowserApi;
	approve: (prompt: PwExtApprovalPrompt, timeoutMs: number) => Promise<boolean>;
	isChromium?: () => boolean;
}) {
	async function activeTab(): Promise<Tab | undefined> {
		const window = await api.windows.getLastFocused({ windowTypes: ["normal"] });
		if (window.id === undefined) return undefined;
		const [tab] = await api.tabs.query({ active: true, windowId: window.id });
		return tab;
	}

	async function inPage(tabId: number, action: PwExtPageAction) {
		const [frame] = await api.scripting.executeScript({
			target: { tabId },
			func: pwExtPageAction,
			args: [action],
		});
		const result = frame?.result as PwExtPageResult | undefined;
		if (!result) throw new Error("The page returned no result.");
		return result;
	}

	async function listTabs(active: Tab): Promise<string> {
		const tabs = (await api.tabs.query({})).slice(0, MAX_TABS);
		const rows = tabs.map((tab) => {
			const mark = tab.id === active.id ? "[active] " : "";
			const title = shownTitle(tab);
			return `- ${mark}${tab.id}: ${title ? `${title} — ` : ""}${shownUrl(tab)}`;
		});
		return [...pageLines(active), "### Tabs", ...rows].join("\n");
	}

	async function run(
		request: PwExtRequest,
		tab: Tab & { id: number },
	): Promise<PwExtResult> {
		const ok = (text: string, image?: string): PwExtResult => ({
			ok: true,
			data: { text: clean(text), ...(image ? { image } : {}) },
		});
		switch (request.verb) {
			case "current":
				return ok(await listTabs(tab));
			case "open": {
				const opened = await api.tabs.create({
					url: request.url as string,
					windowId: tab.windowId,
					active: true,
				});
				return ok(`### Result\nOpened ${request.url} in tab ${opened.id}`);
			}
			case "screenshot": {
				const captured = await api.tabs.captureVisibleTab(tab.windowId as number, {
					format: "jpeg",
					quality: JPEG_QUALITY,
				});
				const fitted = await fitPreviewDataUrl(captured);
				if (!fitted.dataUrl)
					return { ok: false, error: `Screenshot failed: ${fitted.reason}.` };
				return ok(pageLines(tab).join("\n"), fitted.dataUrl);
			}
			default: {
				const action: PwExtPageAction =
					request.verb === "click"
						? { kind: "click", target: request.target as string }
						: request.verb === "fill"
							? {
									kind: "fill",
									target: request.target as string,
									value: request.value as string,
								}
							: { kind: request.verb };
				const result = await inPage(tab.id, action);
				if ("error" in result) return { ok: false, error: clean(result.error) };
				if ("tree" in result)
					return ok(
						[
							...pageLines(tab),
							"### Snapshot",
							result.tree,
							"### Visible text",
							result.text,
						].join("\n"),
					);
				if ("detail" in result)
					return ok([`### Result`, result.detail, ...pageLines(tab)].join("\n"));
				if ("entries" in result)
					return ok(
						[
							...pageLines(tab),
							"### Console",
							result.started
								? "Capture started on this tab. Errors from now on show on the next console call."
								: result.entries.length
									? result.entries.join("\n")
									: "No errors since capture started.",
						].join("\n"),
					);
				return ok([...pageLines(tab), "### Selection", result.text].join("\n"));
			}
		}
	}

	return async (raw: PwExtRequest, timeoutMs: number): Promise<PwExtResult> => {
		let request: PwExtRequest;
		try {
			request = validatePwExtRequest(raw);
		} catch {
			return { ok: false, error: "Unsupported pw --ext request." };
		}
		if (!isChromium())
			return {
				ok: false,
				error: "pw --ext works only in Chromium-family browsers (Chrome, Edge, Brave, Vivaldi).",
			};
		try {
			const tab = await activeTab();
			if (!tab || tab.id === undefined)
				return { ok: false, error: "No active tab in a normal browser window." };
			const scoped = request.verb !== "current" && request.verb !== "open";
			if (scoped && !allowedPage(tab.url))
				return { ok: false, error: PW_EXT_BLOCKED_ERROR };
			if (scoped && mailbox(tab.url))
				return { ok: false, error: PW_EXT_MAILBOX_ERROR };
			const approved = await approve(
				{
					verb: request.verb,
					write: isPwExtWriteVerb(request.verb),
					tabTitle: shownTitle(tab),
					tabUrl: shownUrl(tab),
					...(detailFor(request) ? { detail: detailFor(request) } : {}),
				},
				timeoutMs,
			);
			if (!approved)
				return { ok: false, error: "The request was denied in the browser." };
			if (scoped) {
				const now = await api.tabs.get(tab.id);
				if (now.url !== tab.url || now.active === false)
					return {
						ok: false,
						error: "The tab changed after approval; nothing was done. Retry.",
					};
			}
			return await run(request, { ...tab, id: tab.id });
		} catch (error) {
			return {
				ok: false,
				error: clean(
					`pw --ext failed in the browser: ${error instanceof Error ? error.message : String(error)}`,
				).slice(0, 2048),
			};
		}
	};
}
