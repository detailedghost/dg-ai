import { browser } from "wxt/browser";
import { type GroupColor, getConfig } from "../config";
import { readGroupMarker, stripGroupMarker } from "../marker";

/**
 * Marker-driven tab grouping. Only tabs whose URL carries a `_tab_group=<name>`
 * marker (added by the CLI) are grouped — into <name> — after which the marker is
 * stripped from the URL. Pages the user browses normally are never touched.
 */

/** Does this browser expose the grouping APIs? Chrome, Edge, and Firefox 139+. */
export function tabGroupingSupported(): boolean {
	return (
		typeof browser.tabs?.group === "function" &&
		typeof browser.tabGroups?.update === "function"
	);
}

const TAB_GROUP_ID_NONE = browser.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

// Serialize group ops so a batch opened together lands in ONE group, no race.
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): Promise<void> {
	queue = queue
		.then(task)
		.catch((err) => console.error("[dg-ai-extension]", err));
	return queue;
}

async function addToGroup(
	tabId: number,
	windowId: number,
	title: string,
	color: GroupColor,
): Promise<void> {
	const existing = await browser.tabGroups.query({ windowId, title });
	if (existing.length > 0 && existing[0].id !== undefined) {
		await browser.tabs.group({ tabIds: [tabId], groupId: existing[0].id });
		return;
	}
	const groupId = await browser.tabs.group({ tabIds: [tabId] });
	await browser.tabGroups.update(groupId, { title, color });
}

/** Group a marked tab into its named group, then strip the marker from its URL. */
export function onTabComplete(tabId: number): Promise<void> {
	return enqueue(async () => {
		const tab = await browser.tabs.get(tabId).catch(() => undefined);
		if (!tab?.url || tab.windowId === undefined) return;

		const name = readGroupMarker(tab.url);
		if (!name) return; // only tabs the CLI marked

		const alreadyGrouped =
			typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE;
		if (!alreadyGrouped) {
			const { color } = await getConfig();
			await addToGroup(tabId, tab.windowId, name, color);
		}

		const clean = stripGroupMarker(tab.url);
		if (clean !== tab.url) await browser.tabs.update(tabId, { url: clean });
	});
}
