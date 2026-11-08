import { mock } from "bun:test";
import type { PwExtBrowserApi } from "@/lib/background/pw-ext";

export type FakeWindow = {
	id: number;
	type: "normal" | "popup";
	incognito: boolean;
	state: "normal" | "minimized" | "maximized";
	focused: boolean;
};

export type FakeTab = {
	id: number;
	windowId: number;
	groupId: number;
	url: string;
	title: string;
	active: boolean;
	incognito?: boolean;
	discarded?: boolean;
	autoDiscardable?: boolean;
};

export type FakeGroup = {
	id: number;
	windowId: number;
	title: string;
	color?: string;
};

export type AgentRecord = {
	sessionId: string;
	agentIdentity: string;
	groupId: number;
	title: string;
	color: string;
	selectedTabId?: number;
};

type Listeners = {
	activated: Set<(info: { tabId: number; windowId: number }) => void>;
	updated: Set<(tabId: number, change: Record<string, unknown>) => void>;
	removed: Set<(tabId: number) => void>;
};

export const TAB_GROUP_ID_NONE = -1;
export const agentRecordKey = (sessionId: string) => `agentTabs:${sessionId}`;

export function windowOf(overrides: Partial<FakeWindow> = {}): FakeWindow {
	return {
		id: 1,
		type: "normal",
		incognito: false,
		state: "normal",
		focused: true,
		...overrides,
	};
}

export function tabOf(overrides: Partial<FakeTab> & { id: number }): FakeTab {
	return {
		windowId: 1,
		groupId: TAB_GROUP_ID_NONE,
		url: `https://page-${overrides.id}.example.test/`,
		title: `Page ${overrides.id}`,
		active: false,
		...overrides,
	};
}

export function recordOf(
	overrides: Partial<AgentRecord> & { groupId: number },
): AgentRecord {
	const sessionId = overrides.sessionId ?? "session-1";
	return {
		sessionId,
		agentIdentity: "agent",
		title: `agent · ${sessionId.slice(0, 4)}`,
		color: "blue",
		...overrides,
	};
}

export function createLock() {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		request<T>(...args: unknown[]): Promise<T> {
			const run = args[args.length - 1] as () => Promise<T> | T;
			const next = tail.then(() => run());
			tail = next.catch(() => undefined);
			return next;
		},
	};
}

export function createFakeBrowser(
	seed: {
		windows?: FakeWindow[];
		tabs?: FakeTab[];
		groups?: FakeGroup[];
		lastFocusedWindowId?: number;
	} = {},
) {
	const windows = new Map(
		(seed.windows ?? [windowOf()]).map((w) => [w.id, { ...w }]),
	);
	const tabs = new Map((seed.tabs ?? []).map((t) => [t.id, { ...t }]));
	const groups = new Map((seed.groups ?? []).map((g) => [g.id, { ...g }]));
	const session = new Map<string, unknown>();
	const listeners: Listeners = {
		activated: new Set(),
		updated: new Set(),
		removed: new Set(),
	};
	const state = {
		lastFocusedWindowId: seed.lastFocusedWindowId ?? [...windows.keys()][0],
		nextTabId: 100,
		nextGroupId: 50,
		nextWindowId: 500,
		capture: "data:image/jpeg;base64,AAAA",
		pendingActivations: [] as Array<{ tabId: number; windowId: number }>,
		duringCapture: undefined as (() => void) | undefined,
		script: ((_details: unknown): unknown => undefined) as (
			details: unknown,
		) => unknown,
	};

	const need = (id: number): FakeTab => {
		const tab = tabs.get(id);
		if (!tab) throw new Error(`No tab with id: ${id}`);
		return tab;
	};
	const windowFor = (id: number): FakeWindow => {
		const found = windows.get(id);
		if (!found) throw new Error(`No window with id: ${id}`);
		return found;
	};
	const view = (tab: FakeTab) => ({ ...tab });
	const addTab = (overrides: Partial<FakeTab> & { id: number }): FakeTab => {
		const tab = tabOf(overrides);
		tab.incognito = overrides.incognito ?? windows.get(tab.windowId)?.incognito;
		tabs.set(tab.id, tab);
		return tab;
	};
	const activate = (tab: FakeTab) => {
		for (const other of tabs.values())
			if (other.windowId === tab.windowId) other.active = false;
		tab.active = true;
		state.pendingActivations.push({ tabId: tab.id, windowId: tab.windowId });
	};
	const flushActivations = () => {
		const pending = state.pendingActivations.splice(0);
		for (const info of pending) for (const fn of listeners.activated) fn(info);
	};
	const removeTab = (id: number) => {
		const groupId = tabs.get(id)?.groupId;
		tabs.delete(id);
		if (
			groupId !== undefined &&
			groupId !== TAB_GROUP_ID_NONE &&
			![...tabs.values()].some((tab) => tab.groupId === groupId)
		)
			groups.delete(groupId);
		for (const fn of listeners.removed) fn(id);
	};
	const createTab = (props: {
		url: string;
		windowId?: number;
		active?: boolean;
	}) => {
		const windowId = props.windowId ?? state.lastFocusedWindowId;
		windowFor(windowId);
		const tab = addTab({
			id: state.nextTabId++,
			windowId,
			url: props.url,
			title: "",
		});
		if (props.active) activate(tab);
		return tab;
	};

	const raw = {
		windows: {
			getLastFocused: mock(async (_options?: unknown) =>
				windowFor(state.lastFocusedWindowId),
			),
			create: mock(async (props: { url: string; focused?: boolean }) => {
				const id = state.nextWindowId++;
				windows.set(id, windowOf({ id, focused: props.focused ?? true }));
				const tab = addTab({
					id: state.nextTabId++,
					windowId: id,
					url: props.url,
					title: "",
				});
				return { ...windowFor(id), tabs: [view(tab)] };
			}),
			get: mock(async (id: number) => ({ ...windowFor(id) })),
			update: mock(
				async (
					id: number,
					props: { focused?: boolean; state?: "normal" | "minimized" },
				) => {
					const target = windowFor(id);
					if (props.state) target.state = props.state;
					if (props.focused) state.lastFocusedWindowId = id;
					return { ...target };
				},
			),
		},
		tabs: {
			create: mock(
				async (props: { url: string; windowId?: number; active?: boolean }) =>
					view(createTab(props)),
			),
			update: mock(
				async (
					id: number,
					props: { url?: string; active?: boolean; autoDiscardable?: boolean },
				) => {
					const tab = need(id);
					if (props.url !== undefined) tab.url = props.url;
					if (props.autoDiscardable !== undefined)
						tab.autoDiscardable = props.autoDiscardable;
					if (props.active) activate(tab);
					return view(tab);
				},
			),
			remove: mock(async (ids: number | number[]) => {
				for (const id of Array.isArray(ids) ? ids : [ids]) {
					need(id);
					removeTab(id);
				}
			}),
			group: mock(
				async ({
					tabIds,
					groupId,
					createProperties,
				}: {
					tabIds: number[];
					groupId?: number;
					createProperties?: { windowId: number };
				}) => {
					const first = need(tabIds[0] as number);
					if (
						createProperties &&
						createProperties.windowId !== first.windowId
					)
						throw new Error("tab is not in the requested window");
					let id = groupId;
					if (id === undefined) {
						id = state.nextGroupId++;
						groups.set(id, { id, windowId: first.windowId, title: "" });
					}
					const group = groups.get(id);
					if (!group) throw new Error(`No group with id: ${id}`);
					if (group.windowId !== first.windowId)
						throw new Error("tab and group are in different windows");
					for (const tabId of tabIds) need(tabId).groupId = id;
					return id;
				},
			),
			get: mock(async (id: number) => view(need(id))),
			query: mock(
				async (query: {
					groupId?: number;
					active?: boolean;
					windowId?: number;
				}) =>
					[...tabs.values()]
						.filter(
							(tab) =>
								(query.groupId === undefined || tab.groupId === query.groupId) &&
								(query.active === undefined || tab.active === query.active) &&
								(query.windowId === undefined || tab.windowId === query.windowId),
						)
						.map(view),
			),
			captureVisibleTab: mock(async (_windowId: number, _options?: unknown) => {
				flushActivations();
				state.duringCapture?.();
				return state.capture;
			}),
			onActivated: {
				addListener: (fn: Listeners["activated"] extends Set<infer F> ? F : never) =>
					listeners.activated.add(fn),
				removeListener: (fn: Listeners["activated"] extends Set<infer F> ? F : never) =>
					listeners.activated.delete(fn),
			},
			onUpdated: {
				addListener: (fn: Listeners["updated"] extends Set<infer F> ? F : never) =>
					listeners.updated.add(fn),
				removeListener: (fn: Listeners["updated"] extends Set<infer F> ? F : never) =>
					listeners.updated.delete(fn),
			},
			onRemoved: {
				addListener: (fn: (tabId: number) => void) => listeners.removed.add(fn),
				removeListener: (fn: (tabId: number) => void) =>
					listeners.removed.delete(fn),
			},
		},
		tabGroups: {
			update: mock(
				async (id: number, props: { title?: string; color?: string }) => {
					const group = groups.get(id);
					if (!group) throw new Error(`No group with id: ${id}`);
					Object.assign(group, props);
					return { ...group };
				},
			),
			get: mock(async (id: number) => {
				const group = groups.get(id);
				if (!group) throw new Error(`No group with id: ${id}`);
				return { ...group };
			}),
		},
		scripting: {
			executeScript: mock(async (details: unknown) => [
				{ frameId: 0, result: await state.script(details) },
			]),
		},
		storage: {
			session: {
				get: mock(async (keys?: string | string[] | null) => {
					if (keys === undefined || keys === null)
						return Object.fromEntries(session);
					const wanted = Array.isArray(keys) ? keys : [keys];
					return Object.fromEntries(
						wanted.filter((key) => session.has(key)).map((key) => [key, session.get(key)]),
					);
				}),
				set: mock(async (items: Record<string, unknown>) => {
					for (const [key, value] of Object.entries(items))
						session.set(key, structuredClone(value));
				}),
				remove: mock(async (keys: string | string[]) => {
					for (const key of Array.isArray(keys) ? keys : [keys])
						session.delete(key);
				}),
			},
		},
	};

	return {
		raw,
		api: raw as unknown as PwExtBrowserApi,
		state,
		windows,
		tabs,
		groups,
		session,
		addTab,
		addGroup(group: FakeGroup) {
			groups.set(group.id, { ...group });
			return group;
		},
		dropGroup(id: number) {
			groups.delete(id);
			for (const tab of tabs.values())
				if (tab.groupId === id) tab.groupId = TAB_GROUP_ID_NONE;
		},
		removeTab,
		flushActivations,
		fireActivated(info: { tabId: number; windowId: number }) {
			for (const fn of listeners.activated) fn(info);
		},
		seedRecord(record: AgentRecord) {
			session.set(agentRecordKey(record.sessionId), structuredClone(record));
		},
		record(sessionId: string): AgentRecord | undefined {
			return session.get(agentRecordKey(sessionId)) as AgentRecord | undefined;
		},
		tabsInGroup: (groupId: number) =>
			[...tabs.values()].filter((tab) => tab.groupId === groupId),
	};
}

export type FakeBrowser = ReturnType<typeof createFakeBrowser>;
