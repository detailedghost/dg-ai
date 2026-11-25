import { PW_EXT_MAX_TEXT_CHARS, PW_EXT_NO_TAB_ERROR } from "@dg/common";
import { type PageRequest, type PageResult, validate } from "@dg/common/pw-ext-verbs/page";
import type { AgentTabs } from "../agent-tabs";
import type { PwExtBrowserApi } from "../pw-ext";
import type { SessionControl } from "../session-control";
import { siteOf } from "../site-key";
import { allowedPage, mailbox, PW_EXT_BLOCKED_ERROR, PW_EXT_MAILBOX_ERROR, PW_EXT_PRIVATE_ERROR } from "../tab-guards";

type EvalOutcome = { ok: true; text: string } | { ok: false; error: string };

export type PageBrowserApi = Pick<PwExtBrowserApi, "scripting"> & {
	tabs: { get(tabId: number): Promise<{ windowId?: number; url?: string; incognito?: boolean; discarded?: boolean }> };
	windows: {
		get(windowId: number): Promise<{ incognito?: boolean }>;
		update(windowId: number, props: { width: number; height: number; state: "normal" }): Promise<unknown>;
	};
};

const BAD_REPLY = "The page gave an unreadable reply; the script may have run.";

const notInGroup = (tabId: number) =>
	`pw --ext: tab ${tabId} is not in this agent's tab group; run pw --ext tabs to list them.`;

const refuse = (error: string): PageResult => ({ ok: false, error });

/** Runs inside the page, so it must stay self-contained. Reports only the error name, never its message. */
export async function evaluate(expression: string, expectedUrl: string): Promise<EvalOutcome> {
	if (location.href !== expectedUrl) return { ok: false, error: "The page changed before the script ran; nothing ran." };
	try {
		const value = await (0, eval)(expression);
		return { ok: true, text: value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value)) };
	} catch (error) {
		const name = error instanceof Error ? error.name : "Error";
		return { ok: false, error: `The page refused the script (${name}).` };
	}
}

function outcomeOf(raw: unknown): EvalOutcome {
	if (typeof raw !== "object" || raw === null) return { ok: false, error: BAD_REPLY };
	const { ok, text, error } = raw as Record<string, unknown>;
	if (ok === true && typeof text === "string") return { ok: true, text };
	if (ok === false && typeof error === "string") return { ok: false, error };
	return { ok: false, error: BAD_REPLY };
}

const clip = (text: string) => (text.length > PW_EXT_MAX_TEXT_CHARS ? `${text.slice(0, PW_EXT_MAX_TEXT_CHARS)}\n[clipped]` : text);

export function createPageVerbHandler({
	browserApi,
	agentTabs,
	control,
}: {
	browserApi: PageBrowserApi;
	agentTabs: Pick<AgentTabs, "owns" | "selected" | "select">;
	control: Pick<SessionControl, "allowed">;
}) {
	async function ownedTab(sessionId: string, requested: number | undefined) {
		const tabId = requested ?? (await agentTabs.selected({ sessionId }))?.tabId;
		if (tabId === undefined) return { ok: false, error: PW_EXT_NO_TAB_ERROR } as const;
		if (!(await agentTabs.owns({ sessionId, tabId }))) return { ok: false, error: notInGroup(tabId) } as const;
		const tab = await browserApi.tabs.get(tabId).catch(() => undefined);
		if (!tab || !(await agentTabs.owns({ sessionId, tabId }))) return { ok: false, error: notInGroup(tabId) } as const;
		return { ok: true, tabId, tab } as const;
	}

	async function run(request: Extract<PageRequest, { verb: "eval" }>, sessionId: string): Promise<PageResult> {
		const found = await ownedTab(sessionId, request.tabId);
		if (!found.ok) return refuse(found.error);
		const { tabId, tab } = found;
		if (tab.incognito) return refuse(PW_EXT_PRIVATE_ERROR);
		if (!allowedPage(tab.url)) return refuse(PW_EXT_BLOCKED_ERROR);
		if (mailbox(tab.url)) return refuse(PW_EXT_MAILBOX_ERROR);
		if (tab.discarded)
			return refuse(`This agent's tab was discarded by the browser. Run pw --ext select ${tabId} again after it reloads.`);
		const site = siteOf(tab.url);
		if (!(await control.allowed(sessionId, site.key)))
			return refuse(`pw --ext: ${site.name} is not on this session's allowed sites; eval did not run.`);
		const [frame] = await browserApi.scripting.executeScript({
			target: { tabId },
			world: "MAIN",
			func: evaluate as never,
			args: [request.expression, tab.url],
		});
		const outcome = outcomeOf(frame?.result);
		return outcome.ok ? { ok: true, data: { text: `### Result\n${clip(outcome.text)}` } } : refuse(outcome.error);
	}

	async function select(tabId: number, sessionId: string): Promise<PageResult> {
		if (!(await agentTabs.owns({ sessionId, tabId }))) return refuse(notInGroup(tabId));
		try {
			await agentTabs.select({ sessionId, tabId });
		} catch (error) {
			return refuse(`pw --ext tab-select failed on tab ${tabId}: ${error instanceof Error ? error.message : "the browser refused"}`);
		}
		return { ok: true, data: { text: `### Result\nSelected tab ${tabId}` } };
	}

	async function resize(request: Extract<PageRequest, { verb: "resize" }>, sessionId: string): Promise<PageResult> {
		const found = await ownedTab(sessionId, request.tabId);
		if (!found.ok) return refuse(found.error);
		const { windowId, incognito } = found.tab;
		if (incognito || windowId === undefined) return refuse(PW_EXT_PRIVATE_ERROR);
		if ((await browserApi.windows.get(windowId).catch(() => undefined))?.incognito !== false) return refuse(PW_EXT_PRIVATE_ERROR);
		try {
			await browserApi.windows.update(windowId, { width: request.width, height: request.height, state: "normal" });
		} catch (error) {
			return refuse(`pw --ext resize failed: ${error instanceof Error ? error.message : "the browser refused"}`);
		}
		return { ok: true, data: { text: `### Result\nResized the agent window to ${request.width}x${request.height}` } };
	}

	return async function handle(input: unknown, { sessionId }: { sessionId: string }): Promise<PageResult> {
		let request: PageRequest;
		try {
			request = validate(input);
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error));
		}
		if (request.verb === "eval") return run(request, sessionId);
		if (request.verb === "tab-select") return select(request.tabId, sessionId);
		return resize(request, sessionId);
	};
}
