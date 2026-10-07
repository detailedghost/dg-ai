import { createSerialQueue } from "@dg/common";
import { browser } from "wxt/browser";
import {
	readGroupBatch,
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

const queues = new Map<string, ReturnType<typeof createSerialQueue>>();

function queueFor(title: string) {
	let enqueue = queues.get(title);
	if (!enqueue) {
		enqueue = createSerialQueue((err) =>
			console.error("[dg-ai-extension]", err),
		);
		queues.set(title, enqueue);
	}
	return enqueue;
}

type BatchSlot = { batch: string; pos: number };

const batchSlots = new Map<number, BatchSlot>();

export function forgetTab(tabId: number): void {
	batchSlots.delete(tabId);
}

async function findGroup(
	windowId: number,
	title: string,
): Promise<{ id: number; windowId: number } | undefined> {
	const found = (await browser.tabGroups.query({ title })).filter(
		(g): g is typeof g & { id: number } => g.id !== undefined,
	);
	const local = found.filter((g) => g.windowId === windowId);
	const pool = local.length ? local : found;
	if (!pool.length) return undefined;
	const newest = pool.reduce((a, b) => (b.id > a.id ? b : a));
	return { id: newest.id, windowId: newest.windowId };
}

async function addToGroup(
	tabId: number,
	windowId: number,
	title: string,
	color: GroupColor,
): Promise<number> {
	const existing = await findGroup(windowId, title);
	if (existing) {
		if (existing.windowId !== windowId) {
			await browser.tabs.move(tabId, {
				windowId: existing.windowId,
				index: -1,
			});
		}
		await browser.tabs.group({ tabIds: [tabId], groupId: existing.id });
		return existing.id;
	}
	const groupId = await browser.tabs.group({ tabIds: [tabId] });
	await browser.tabGroups.update(groupId, { title, color });
	return groupId;
}

async function positionInBatch(
	tabId: number,
	groupId: number,
	slot: BatchSlot,
): Promise<void> {
	const groupTabs = await browser.tabs.query({ groupId } as never);
	let lowerEnd = -1;
	let higherStart = Number.POSITIVE_INFINITY;
	for (const t of groupTabs) {
		if (t.id === undefined || t.id === tabId || t.index === undefined) continue;
		const other = batchSlots.get(t.id);
		if (other?.batch !== slot.batch) continue;
		if (other.pos < slot.pos) lowerEnd = Math.max(lowerEnd, t.index);
		else higherStart = Math.min(higherStart, t.index);
	}
	const target =
		lowerEnd >= 0
			? lowerEnd + 1
			: Number.isFinite(higherStart)
				? higherStart
				: undefined;
	if (target === undefined) return;
	await browser.tabs.move(tabId, { index: target }).catch(() => {});
}

/** Group a marked tab into its named group, then strip the marker from its URL. */
export async function onTabComplete(tabId: number): Promise<void> {
	const tab = await browser.tabs.get(tabId).catch(() => undefined);
	if (!tab?.url || tab.windowId === undefined) return;
	const name = readGroupMarker(tab.url);
	if (!name) return;

	return queueFor(name)(async () => {
		const current = await browser.tabs.get(tabId).catch(() => undefined);
		if (!current?.url || current.windowId === undefined) return;
		const { url, windowId } = current;
		const alreadyGrouped =
			typeof current.groupId === "number" &&
			current.groupId !== TAB_GROUP_ID_NONE;
		if (!alreadyGrouped) {
			const { color } = await getConfig();
			const groupId = await addToGroup(
				tabId,
				windowId,
				name,
				resolveColor(color),
			);
			const pos = readGroupPos(url);
			if (pos !== undefined) {
				const slot = { batch: readGroupBatch(url) ?? name, pos };
				batchSlots.set(tabId, slot);
				await positionInBatch(tabId, groupId, slot);
			}
		}

		const clean = stripGroupMarker(url);
		if (clean !== url) await browser.tabs.update(tabId, { url: clean });
	});
}
