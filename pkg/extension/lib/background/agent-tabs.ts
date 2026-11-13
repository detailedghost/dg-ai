import { describeError } from "@dg/common";
import {
	type AgentTabAdoptReply,
	type AgentTabsReply,
	BLOCKED_TAB_ERROR,
	MSG,
	PRIVATE_TAB_ERROR,
} from "@dg/pages/chat-messages";
import { browser } from "wxt/browser";
import { GROUP_COLORS, type GroupColor } from "@/lib/config";
import { createPairingStore } from "./pairing-store";
import { allowedPage, mailbox } from "./tab-guards";

export type BrowserTab = {
	id?: number;
	windowId?: number;
	groupId?: number;
	url?: string;
	pendingUrl?: string;
	title?: string;
	active?: boolean;
	incognito?: boolean;
	discarded?: boolean;
	autoDiscardable?: boolean;
};

export type AgentTabsBrowserApi = {
	windows: {
		getLastFocused(options: { windowTypes: ["normal"] }): Promise<{
			id?: number;
			type?: string;
			incognito?: boolean;
		}>;
		get(windowId: number): Promise<{ incognito?: boolean; state?: string }>;
		create(props: {
			url: string;
			focused: boolean;
		}): Promise<{ tabs?: BrowserTab[] }>;
	};
	tabs: {
		create(props: {
			url: string;
			windowId: number;
			active: boolean;
		}): Promise<BrowserTab>;
		update(
			tabId: number,
			props: { url?: string; active?: boolean; autoDiscardable?: boolean },
		): Promise<BrowserTab>;
		remove(tabId: number): Promise<void>;
		group(options: {
			tabIds: number[];
			groupId?: number;
			createProperties?: { windowId: number };
		}): Promise<number>;
		get(tabId: number): Promise<BrowserTab>;
		query(query: {
			groupId?: number;
			active?: boolean;
			windowId?: number;
		}): Promise<BrowserTab[]>;
	};
	tabGroups: {
		update(
			groupId: number,
			props: { title: string; color: GroupColor },
		): Promise<unknown>;
		get(groupId: number): Promise<{
			windowId: number;
			color?: GroupColor;
		}>;
	};
};

export type AgentTabsStorage = {
	session: {
		get(keys: string | null): Promise<Record<string, unknown>>;
		set(items: Record<string, unknown>): Promise<void>;
		remove(keys: string): Promise<void>;
	};
};

export type AgentTabsLock = {
	request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export type AgentRecord = {
	sessionId: string;
	agentIdentity: string;
	groupId: number;
	title: string;
	color: GroupColor;
	selectedTabId?: number;
};

export type AgentTab = {
	tabId: number;
	title: string;
	url: string;
	selected: boolean;
	active: boolean;
};

const RECORD_PREFIX = "agentTabs:";
const LOCK_NAME = "agentTabs";
const TITLE_IDENTITY_CHARS = 33;
const TITLE_SESSION_CHARS = 4;

export const MAX_AGENT_TABS = 200;

export class AgentGroupFullError extends Error {
	constructor() {
		super(`The agent tab group is full (${MAX_AGENT_TABS} tabs).`);
	}
}

const recordKey = (sessionId: string) => `${RECORD_PREFIX}${sessionId}`;

/** At most 40 characters, so the session suffix always survives. */
export function groupTitle({
	agentIdentity,
	sessionId,
}: {
	agentIdentity: string;
	sessionId: string;
}): string {
	return `${agentIdentity.slice(0, TITLE_IDENTITY_CHARS)} · ${sessionId.slice(0, TITLE_SESSION_CHARS)}`;
}

async function readRecords(storage: AgentTabsStorage): Promise<AgentRecord[]> {
	const stored = await storage.session.get(null);
	return Object.entries(stored)
		.filter(([key]) => key.startsWith(RECORD_PREFIX))
		.map(([, record]) => record as AgentRecord);
}

/** Agent group ids read under the agent tab lock, so an adopt in flight saves its record first. */
export function lockedAgentGroupIds({
	storage,
	lock = navigator.locks,
}: {
	storage: AgentTabsStorage;
	lock?: AgentTabsLock;
}): Promise<Set<number>> {
	return lock.request(LOCK_NAME, () => agentGroupIds({ storage }));
}

/** Chrome tab group ids that belong to an agent session. */
export async function agentGroupIds({
	storage,
}: {
	storage: AgentTabsStorage;
}): Promise<Set<number>> {
	return new Set((await readRecords(storage)).map((record) => record.groupId));
}

function withoutSelection(record: AgentRecord): AgentRecord {
	const next = { ...record };
	delete next.selectedTabId;
	return next;
}

function leastUsedColor(records: readonly AgentRecord[]): GroupColor {
	const uses = (color: GroupColor) =>
		records.filter((record) => record.color === color).length;
	return GROUP_COLORS.reduce((best, color) =>
		uses(color) < uses(best) ? color : best,
	);
}

export function createAgentTabs({
	browserApi: api,
	storage,
	lock = navigator.locks,
	busy = () => false,
}: {
	browserApi: AgentTabsBrowserApi;
	storage: AgentTabsStorage;
	lock?: AgentTabsLock;
	busy?(agent: { sessionId: string }): boolean;
}) {
	const locked = <T>(task: () => Promise<T>) => lock.request(LOCK_NAME, task);

	async function read(sessionId: string): Promise<AgentRecord | undefined> {
		const key = recordKey(sessionId);
		return (await storage.session.get(key))[key] as AgentRecord | undefined;
	}

	async function write(record: AgentRecord): Promise<void> {
		await storage.session.set({ [recordKey(record.sessionId)]: record });
	}

	async function rows(record: AgentRecord): Promise<AgentTab[]> {
		const tabs = await api.tabs.query({ groupId: record.groupId });
		return tabs.flatMap((tab) =>
			tab.id === undefined || tab.incognito
				? []
				: [
						{
							tabId: tab.id,
							title: tab.title ?? "",
							url: tab.url || tab.pendingUrl || "",
							selected: tab.id === record.selectedTabId,
							active: tab.active ?? false,
						},
					],
		);
	}

	async function inGroup(record: AgentRecord, tabId: number): Promise<boolean> {
		const tab = await api.tabs.get(tabId).catch(() => undefined);
		return tab?.groupId === record.groupId;
	}

	async function requireInGroup(
		record: AgentRecord,
		tabId: number,
	): Promise<void> {
		if (!(await inGroup(record, tabId)))
			throw new Error(`Tab ${tabId} is not in this agent's tab group.`);
	}

	async function liveGroupWindow(
		record: AgentRecord | undefined,
	): Promise<number | undefined> {
		if (!record) return undefined;
		const group = await api.tabGroups.get(record.groupId).catch(() => undefined);
		if (!group) return undefined;
		const window = await api.windows.get(group.windowId).catch(() => undefined);
		return window && !window.incognito ? group.windowId : undefined;
	}

	async function normalWindow(): Promise<number | undefined> {
		const window = await api.windows
			.getLastFocused({ windowTypes: ["normal"] })
			.catch(() => undefined);
		return window?.type === "normal" && !window.incognito
			? window.id
			: undefined;
	}

	async function createTab(url: string, windowId: number | undefined) {
		if (windowId !== undefined)
			return api.tabs.create({ url, windowId, active: false });
		const [first] = (await api.windows.create({ url, focused: false })).tabs ?? [];
		if (!first) throw new Error("The browser opened no tab.");
		return first;
	}

	async function joinGroup({
		record,
		groupWindow,
		sessionId,
		agentIdentity,
		tabId,
		windowId,
	}: {
		record: AgentRecord | undefined;
		groupWindow: number | undefined;
		sessionId: string;
		agentIdentity: string;
		tabId: number;
		windowId: number | undefined;
	}): Promise<AgentRecord> {
		if (record && groupWindow !== undefined) {
			await api.tabs.group({ groupId: record.groupId, tabIds: [tabId] });
			return record;
		}
		const groupId = await api.tabs.group({
			tabIds: [tabId],
			...(windowId === undefined ? {} : { createProperties: { windowId } }),
		});
		const title = groupTitle({ agentIdentity, sessionId });
		const color =
			record?.color ??
			leastUsedColor(
				(await readRecords(storage)).filter(
					(other) => other.sessionId !== sessionId,
				),
			);
		await api.tabGroups.update(groupId, { title, color });
		return { sessionId, agentIdentity, groupId, title, color };
	}

	return {
		open({
			sessionId,
			agentIdentity,
			url,
		}: {
			sessionId: string;
			agentIdentity: string;
			url: string;
		}): Promise<{ tabId: number }> {
			return locked(async () => {
				const record = await read(sessionId);
				const groupWindow = await liveGroupWindow(record);
				if (
					record &&
					groupWindow !== undefined &&
					(await api.tabs.query({ groupId: record.groupId })).length >=
						MAX_AGENT_TABS
				)
					throw new AgentGroupFullError();
				const tab = await createTab(url, groupWindow ?? (await normalWindow()));
				const tabId = tab.id;
				if (tabId === undefined) throw new Error("The browser opened no tab.");
				try {
					await api.tabs.update(tabId, { autoDiscardable: false });
					const joined = await joinGroup({
						record,
						groupWindow,
						sessionId,
						agentIdentity,
						tabId,
						windowId: tab.windowId,
					});
					if (joined !== record) await write(joined);
					return { tabId };
				} catch (error) {
					await api.tabs.remove(tabId).catch(() => undefined);
					throw error;
				}
			});
		},

		adopt({
			sessionId,
			agentIdentity,
			tabId,
		}: {
			sessionId: string;
			agentIdentity: string;
			tabId: number;
		}): Promise<void> {
			return locked(async () => {
				const tab = await api.tabs.get(tabId).catch(() => undefined);
				if (!tab) throw new Error("tab not found");
				if (tab.incognito) throw new Error(PRIVATE_TAB_ERROR);
				if (!allowedPage(tab.url) || mailbox(tab.url))
					throw new Error(BLOCKED_TAB_ERROR);
				const records = await readRecords(storage);
				const record = records.find((other) => other.sessionId === sessionId);
				if (record && tab.groupId === record.groupId) {
					await write({ ...record, selectedTabId: tabId });
					return;
				}
				const owner = records.find(
					(other) => other.groupId === tab.groupId && other.sessionId !== sessionId,
				);
				if (owner && busy({ sessionId: owner.sessionId }))
					throw new Error(`${owner.agentIdentity} is using this tab`);
				const groupWindow = await liveGroupWindow(record);
				if (
					record &&
					groupWindow !== undefined &&
					(await api.tabs.query({ groupId: record.groupId })).length >=
						MAX_AGENT_TABS
				)
					throw new AgentGroupFullError();
				const joined = await joinGroup({
					record,
					groupWindow,
					sessionId,
					agentIdentity,
					tabId,
					windowId: tab.windowId,
				});
				await write({ ...joined, selectedTabId: tabId });
				if (owner?.selectedTabId === tabId) {
					const last = (await rows(owner)).at(-1);
					await write(
						last
							? { ...owner, selectedTabId: last.tabId }
							: withoutSelection(owner),
					);
				}
			});
		},

		async groups(): Promise<AgentTabsReply["groups"]> {
			return Promise.all(
				(await readRecords(storage)).map(async (record) => {
					const group = await api.tabGroups
						.get(record.groupId)
						.catch(() => undefined);
					return {
						sessionId: record.sessionId,
						color: group?.color ?? record.color,
						tabs: group ? await rows(record) : [],
					};
				}),
			);
		},

		async list({ sessionId }: { sessionId: string }): Promise<AgentTab[]> {
			const record = await read(sessionId);
			return record ? rows(record) : [];
		},

		selected({ sessionId }: { sessionId: string }): Promise<AgentTab | undefined> {
			return locked(async () => {
				const record = await read(sessionId);
				if (record?.selectedTabId === undefined) return undefined;
				const tab = await api.tabs
					.get(record.selectedTabId)
					.catch(() => undefined);
				if (tab?.groupId !== record.groupId) {
					await write(withoutSelection(record));
					return undefined;
				}
				return {
					tabId: record.selectedTabId,
					title: tab.title ?? "",
					url: tab.url ?? "",
					selected: true,
					active: tab.active ?? false,
				};
			});
		},

		select({
			sessionId,
			tabId,
		}: {
			sessionId: string;
			tabId: number;
		}): Promise<void> {
			return locked(async () => {
				const record = await read(sessionId);
				if (!record) throw new Error("This session has no agent tab group.");
				await requireInGroup(record, tabId);
				await write({ ...record, selectedTabId: tabId });
			});
		},

		close({
			sessionId,
			tabId,
		}: {
			sessionId: string;
			tabId?: number;
		}): Promise<{ selectedTabId?: number }> {
			return locked(async () => {
				const record = await read(sessionId);
				const closing = tabId ?? record?.selectedTabId;
				if (!record || closing === undefined)
					throw new Error("This agent has no tab to close.");
				await requireInGroup(record, closing);
				await api.tabs.remove(closing);
				if (closing !== record.selectedTabId) return {};
				const last = (await rows(record)).at(-1);
				if (!last) {
					await write(withoutSelection(record));
					return {};
				}
				await write({ ...record, selectedTabId: last.tabId });
				return { selectedTabId: last.tabId };
			});
		},

		async owns({
			sessionId,
			tabId,
		}: {
			sessionId: string;
			tabId: number;
		}): Promise<boolean> {
			const record = await read(sessionId);
			return record ? inGroup(record, tabId) : false;
		},

		forget({ sessionId }: { sessionId: string }): Promise<void> {
			return locked(() => storage.session.remove(recordKey(sessionId)));
		},

		tabRemoved({ tabId }: { tabId: number }): Promise<void> {
			return locked(async () => {
				for (const record of await readRecords(storage))
					if (record.selectedTabId === tabId) await write(withoutSelection(record));
			});
		},

		groupRemoved({ groupId }: { groupId: number }): Promise<void> {
			return locked(async () => {
				for (const record of await readRecords(storage))
					if (record.groupId === groupId)
						await storage.session.remove(recordKey(record.sessionId));
			});
		},
	};
}

export type AgentTabs = ReturnType<typeof createAgentTabs>;

function adoptRequest(message: unknown) {
	const { sessionId, agentIdentity, tabId } = message as Record<string, unknown>;
	return typeof sessionId === "string" &&
		typeof agentIdentity === "string" &&
		typeof tabId === "number"
		? { sessionId, agentIdentity, tabId }
		: undefined;
}

/** Keep agent records in step with the browser and answer the popup's tab requests. */
export function registerAgentTabs({
	busy,
	onAdopted,
}: { busy?(agent: { sessionId: string }): boolean; onAdopted?(tabId: number): void } = {}): void {
	const storage = browser.storage as unknown as AgentTabsStorage;
	const agentTabs = createAgentTabs({
		browserApi: browser as unknown as AgentTabsBrowserApi,
		storage,
		busy,
	});
	const pairings = createPairingStore({ storage: browser.storage });

	async function answer(
		message: { type: unknown },
		sender: { id?: string; tab?: unknown },
	): Promise<AgentTabsReply | AgentTabAdoptReply> {
		try {
			if (sender.id !== browser.runtime.id || sender.tab !== undefined)
				return { ok: false, error: "not allowed" };
			if (message.type === MSG.agentTabsRequest)
				return { groups: await agentTabs.groups() };
			const request = adoptRequest(message);
			if (!request) return { ok: false, error: "invalid request" };
			const held = (await pairings.list()).find(
				({ sessionId }) => sessionId === request.sessionId,
			);
			if (!held) return { ok: false, error: "this agent is not paired" };
			await agentTabs.adopt({ ...request, agentIdentity: held.agentIdentity });
			onAdopted?.(request.tabId);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: describeError(error) };
		}
	}

	browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
		const type = (message as { type?: unknown } | null | undefined)?.type;
		if (type !== MSG.agentTabsRequest && type !== MSG.agentTabAdopt)
			return undefined;
		void answer(message as { type: unknown }, sender).then(sendResponse);
		return true;
	});

	const logCleanupFailure = (error: unknown) =>
		console.warn("[dg-ai-extension] agent tab cleanup failed", error);

	browser.tabs.onRemoved.addListener(
		(tabId) => void agentTabs.tabRemoved({ tabId }).catch(logCleanupFailure),
	);

	browser.tabGroups.onRemoved.addListener(
		(group) =>
			void agentTabs
				.groupRemoved({ groupId: group.id })
				.catch(logCleanupFailure),
	);
}
