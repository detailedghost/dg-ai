import { isPwExtWebUrl, PW_EXT_NO_TAB_ERROR } from "@dg/common";
import { isProtonMailOrigin } from "@/lib/features/inbox-proton-observer";

export const PW_EXT_BLOCKED_ERROR =
	"pw --ext does not read or change browser settings pages, extension pages, or other non-web pages. Switch to a web page tab and retry.";
export const PW_EXT_MAILBOX_ERROR =
	"pw --ext does not read or change the signed-in Proton Mail tab. Use dg inbox.";
export const PW_EXT_PRIVATE_ERROR =
	"pw --ext never reads or changes a tab in a private window.";

const STORE_HOSTS = new Set([
	"chromewebstore.google.com",
	"chrome.google.com",
	"microsoftedge.microsoft.com",
]);

export function allowedPage(url: string | undefined): url is string {
	if (!url || !isPwExtWebUrl(url)) return false;
	return !STORE_HOSTS.has(new URL(url).hostname);
}

export function mailbox(url: string | undefined): boolean {
	try {
		return isProtonMailOrigin(new URL(url ?? "").origin);
	} catch {
		return false;
	}
}

const OUTLOOK_HOSTS = new Set([
	"outlook.live.com",
	"outlook.office.com",
	"outlook.office365.com",
	"outlook.cloud.microsoft",
]);

export function outlookWeb(url: string | undefined): boolean {
	try {
		return OUTLOOK_HOSTS.has(new URL(url ?? "").hostname);
	} catch {
		return false;
	}
}

export const notInGroup = (tabId: number) =>
	`pw --ext: tab ${tabId} is not in this agent's tab group; run pw --ext tabs to list them.`;
export const discardedTab = (tabId: number) =>
	`This agent's tab was discarded by the browser. Run pw --ext select ${tabId} again after it reloads.`;

type TabState = { url?: string; incognito?: boolean; discarded?: boolean };
type TabLookup<T extends TabState> = {
	agentTabs: {
		owns(agent: { sessionId: string; tabId: number }): Promise<boolean>;
		selected(agent: { sessionId: string }): Promise<{ tabId: number } | undefined>;
	};
	tabs: { get(tabId: number): Promise<T> };
	sessionId: string;
	requested: number | undefined;
};
type Failure = { ok: false; error: string };

export async function ownedTab<T extends TabState>({
	agentTabs,
	tabs,
	sessionId,
	requested,
}: TabLookup<T>): Promise<{ ok: true; tabId: number; tab: T } | Failure> {
	const tabId = requested ?? (await agentTabs.selected({ sessionId }))?.tabId;
	if (tabId === undefined) return { ok: false, error: PW_EXT_NO_TAB_ERROR };
	if (!(await agentTabs.owns({ sessionId, tabId }))) return { ok: false, error: notInGroup(tabId) };
	const tab = await tabs.get(tabId).catch(() => undefined);
	if (!tab || !(await agentTabs.owns({ sessionId, tabId }))) return { ok: false, error: notInGroup(tabId) };
	return { ok: true, tabId, tab };
}

/** The agent's own tab, once it passes the private window, web page, mailbox and discarded checks. */
export async function guardedTab<T extends TabState>(
	lookup: TabLookup<T>,
	{ allowDiscarded = false }: { allowDiscarded?: boolean } = {},
): Promise<{ ok: true; tabId: number; tab: T & { url: string } } | Failure> {
	const found = await ownedTab(lookup);
	if (!found.ok) return found;
	const { tabId, tab } = found;
	if (tab.incognito) return { ok: false, error: PW_EXT_PRIVATE_ERROR };
	if (!allowedPage(tab.url)) return { ok: false, error: PW_EXT_BLOCKED_ERROR };
	if (mailbox(tab.url)) return { ok: false, error: PW_EXT_MAILBOX_ERROR };
	if (tab.discarded && !allowDiscarded) return { ok: false, error: discardedTab(tabId) };
	return { ok: true, tabId, tab: tab as T & { url: string } };
}
