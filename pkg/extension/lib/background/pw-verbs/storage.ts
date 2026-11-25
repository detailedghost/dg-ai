import { PW_EXT_NO_TAB_ERROR } from "@dg/common";
import {
	type StorageAction,
	type StorageArea,
	type StorageRequest,
	type StorageResult,
	storageActionOf,
	storageAreaOf,
	validate,
} from "../../../../common/src/pw-ext-verbs/storage";
import type { AgentTabs } from "../agent-tabs";
import type { PwExtBrowserApi } from "../pw-ext";
import type { SessionControl } from "../session-control";
import { siteOf } from "../site-key";
import {
	allowedPage,
	mailbox,
	PW_EXT_BLOCKED_ERROR,
	PW_EXT_MAILBOX_ERROR,
	PW_EXT_PRIVATE_ERROR,
} from "../tab-guards";

type PageOutcome = { ok: true; removed: number } | { ok: false; error: string };

const MOVED = "The page moved to another origin; nothing was changed.";
const BAD_REPLY = "The page gave an unreadable reply; storage may not have changed.";

/** Runs inside the page, so it must stay self-contained. */
export function writeStorage(
	area: StorageArea,
	action: StorageAction,
	key: string | undefined,
	value: string | undefined,
	origin: string,
): PageOutcome {
	if (location.origin !== origin) return { ok: false, error: MOVED };
	try {
		const store = area === "local" ? localStorage : sessionStorage;
		const before = store.length;
		if (action === "set") store.setItem(key as string, value as string);
		else if (action === "delete") store.removeItem(key as string);
		else store.clear();
		return { ok: true, removed: action === "set" ? 0 : before - store.length };
	} catch (error) {
		const name = error instanceof Error ? error.name : "Error";
		return { ok: false, error: `The page refused the write (${name}).` };
	}
}

const notInGroup = (tabId: number) =>
	`pw --ext: tab ${tabId} is not in this agent's tab group; run pw --ext tabs to list them.`;

function outcomeOf(raw: unknown): PageOutcome {
	if (typeof raw !== "object" || raw === null) return { ok: false, error: BAD_REPLY };
	const { ok, removed, error } = raw as Record<string, unknown>;
	if (ok === true && typeof removed === "number") return { ok: true, removed };
	if (ok === false && typeof error === "string") return { ok: false, error };
	return { ok: false, error: BAD_REPLY };
}

function describe(request: StorageRequest, outcome: { removed: number }, origin: string): string {
	const store = `${storageAreaOf(request.verb)}Storage`;
	const action = storageActionOf(request.verb);
	if (action === "set") return `Set ${store} "${request.key}" on ${origin}`;
	if (action === "delete")
		return `${outcome.removed ? "Deleted" : "Found no"} ${store} "${request.key}" on ${origin}`;
	return `Cleared ${outcome.removed} ${outcome.removed === 1 ? "key" : "keys"} from ${store} on ${origin}`;
}

export function createStorageVerbHandler({
	browserApi,
	agentTabs,
	control,
}: {
	browserApi: Pick<PwExtBrowserApi, "tabs" | "scripting">;
	agentTabs: Pick<AgentTabs, "owns" | "selected">;
	control: Pick<SessionControl, "allowed">;
}) {
	const refuse = (error: string): StorageResult => ({ ok: false, error });

	return async function handle(input: unknown, { sessionId }: { sessionId: string }): Promise<StorageResult> {
		let request: StorageRequest;
		try {
			request = validate(input);
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error));
		}
		let tabId = request.tabId;
		if (tabId === undefined) {
			tabId = (await agentTabs.selected({ sessionId }))?.tabId;
			if (tabId === undefined) return refuse(PW_EXT_NO_TAB_ERROR);
		} else if (!(await agentTabs.owns({ sessionId, tabId })))
			return refuse(notInGroup(tabId));
		const tab = await browserApi.tabs.get(tabId).catch(() => undefined);
		if (!tab || !(await agentTabs.owns({ sessionId, tabId })))
			return refuse(notInGroup(tabId));
		if (tab.incognito) return refuse(PW_EXT_PRIVATE_ERROR);
		if (!allowedPage(tab.url)) return refuse(PW_EXT_BLOCKED_ERROR);
		if (mailbox(tab.url)) return refuse(PW_EXT_MAILBOX_ERROR);
		if (tab.discarded)
			return refuse(`This agent's tab was discarded by the browser. Run pw --ext select ${tabId} again after it reloads.`);
		const site = siteOf(tab.url);
		if (!(await control.allowed(sessionId, site.key)))
			return refuse(`pw --ext: ${site.name} is not on this session's allowed sites; storage was not changed.`);
		const { origin } = new URL(tab.url);
		const [frame] = await browserApi.scripting.executeScript({
			target: { tabId },
			world: "ISOLATED",
			func: writeStorage as never,
			args: [storageAreaOf(request.verb), storageActionOf(request.verb), request.key, request.value, origin],
		});
		const outcome = outcomeOf(frame?.result);
		return outcome.ok
			? { ok: true, data: { text: `### Result\n${describe(request, outcome, origin)}` } }
			: refuse(outcome.error);
	};
}
