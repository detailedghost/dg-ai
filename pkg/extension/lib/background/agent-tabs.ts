import { browser } from "wxt/browser";
import { GROUP_COLORS, type GroupColor } from "@/lib/config";

export type BrowserTab = {
	id?: number;
	windowId?: number;
	groupId?: number;
	url?: string;
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
		group(options: { tabIds: number[]; groupId?: number }): Promise<number>;
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
		get(groupId: number): Promise<{ windowId: number }>;
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
}: {
	browserApi: AgentTabsBrowserApi;
	storage: AgentTabsStorage;
	lock?: AgentTabsLock;
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
							url: tab.url ?? "",
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
					if (record && groupWindow !== undefined) {
						await api.tabs.group({ groupId: record.groupId, tabIds: [tabId] });
						return { tabId };
					}
					const groupId = await api.tabs.group({ tabIds: [tabId] });
					const title = groupTitle({ agentIdentity, sessionId });
					const color =
						record?.color ??
						leastUsedColor(
							(await readRecords(storage)).filter(
								(other) => other.sessionId !== sessionId,
							),
						);
					await api.tabGroups.update(groupId, { title, color });
					await write({ sessionId, agentIdentity, groupId, title, color });
					return { tabId };
				} catch (error) {
					await api.tabs.remove(tabId).catch(() => undefined);
					throw error;
				}
			});
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
	};
}

export type AgentTabs = ReturnType<typeof createAgentTabs>;

/** Clear an agent's selection when its selected tab closes. */
export function registerAgentTabs(): void {
	const storage = browser.storage as unknown as AgentTabsStorage;
	browser.tabs.onRemoved.addListener((tabId) => {
		void navigator.locks
			.request(LOCK_NAME, async () => {
				for (const record of await readRecords(storage))
					if (record.selectedTabId === tabId)
						await storage.session.set({
							[recordKey(record.sessionId)]: withoutSelection(record),
						});
			})
			.catch((error: unknown) =>
				console.warn("[dg-ai-extension] agent tab cleanup failed", error),
			);
	});
}
