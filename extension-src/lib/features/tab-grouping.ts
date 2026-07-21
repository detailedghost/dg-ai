import { browser } from "wxt/browser";
import { type GroupConfig, getConfig } from "../config";
import { urlMatches } from "../glob";

/**
 * Tab grouping feature. Pure browser-side: matches tab URLs against configured
 * globs and drops each into one named/colored group. Isolated here so future
 * features can live alongside it without touching the background entrypoint.
 */

/** Does this browser expose the grouping APIs? Chrome, Edge, and Firefox 139+. */
export function tabGroupingSupported(): boolean {
	return typeof browser.tabs?.group === "function" && typeof browser.tabGroups?.update === "function";
}

const TAB_GROUP_ID_NONE = browser.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

// Serialize group ops so a batch opened together lands in ONE group, no race.
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): Promise<void> {
	queue = queue.then(task).catch((err) => console.error("[dg-ai-browser-batch]", err));
	return queue;
}

async function groupTab(tabId: number, windowId: number, cfg: GroupConfig): Promise<void> {
	const existing = await browser.tabGroups.query({ windowId, title: cfg.title });
	if (existing.length > 0 && existing[0].id !== undefined) {
		await browser.tabs.group({ tabIds: [tabId], groupId: existing[0].id });
		return;
	}
	const groupId = await browser.tabs.group({ tabIds: [tabId] });
	await browser.tabGroups.update(groupId, {
		title: cfg.title,
		color: cfg.color,
	});
}

/** Handle a tab that just finished loading: group it if it matches. */
export function onTabComplete(tabId: number): Promise<void> {
	return enqueue(async () => {
		const cfg = await getConfig();
		const tab = await browser.tabs.get(tabId).catch(() => undefined);
		if (!tab) return; // tab closed before we got to it
		if (typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE) {
			return; // already grouped — never re-group
		}
		if (!tab.url || tab.windowId === undefined) return;
		if (!urlMatches(tab.url, cfg.patterns)) return;
		await groupTab(tabId, tab.windowId, cfg);
	});
}
