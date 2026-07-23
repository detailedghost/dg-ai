import { createSerialQueue } from "@dg/common";
import { browser } from "wxt/browser";
import {
	readGroupMarker,
	readGroupPos,
	stripGroupMarker,
} from "@/utils/marker";
import { type GroupColor, getConfig, resolveColor } from "../config";

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
const enqueue = createSerialQueue((err) =>
	console.error("[dg-ai-extension]", err),
);

async function addToGroup(
	tabId: number,
	windowId: number,
	title: string,
	color: GroupColor,
): Promise<number> {
	const existing = await browser.tabGroups.query({ windowId, title });
	if (existing.length > 0 && existing[0].id !== undefined) {
		await browser.tabs.group({ tabIds: [tabId], groupId: existing[0].id });
		return existing[0].id;
	}
	const groupId = await browser.tabs.group({ tabIds: [tabId] });
	await browser.tabGroups.update(groupId, { title, color });
	return groupId;
}

/**
 * Move a freshly-grouped tab to `pos` within its group (0-based). Ops are
 * serialized, so ordering by the group's current left edge + pos is stable enough
 * for a batch opened together; a no-op when no position was requested.
 */
async function positionInGroup(
	tabId: number,
	groupId: number,
	pos: number | undefined,
): Promise<void> {
	if (pos === undefined) return;
	const groupTabs = await browser.tabs.query({ groupId } as never);
	const indices = groupTabs
		.map((t) => t.index)
		.filter((i): i is number => typeof i === "number");
	if (!indices.length) return;
	const target = Math.min(...indices) + pos;
	await browser.tabs.move(tabId, { index: target }).catch(() => {});
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
			const groupId = await addToGroup(
				tabId,
				tab.windowId,
				name,
				resolveColor(color),
			);
			await positionInGroup(tabId, groupId, readGroupPos(tab.url));
		}

		const clean = stripGroupMarker(tab.url);
		if (clean !== tab.url) await browser.tabs.update(tabId, { url: clean });
	});
}
