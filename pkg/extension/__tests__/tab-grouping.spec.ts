import { beforeEach, describe, expect, it, mock } from "bun:test";

type FakeTab = {
	id: number;
	windowId: number;
	groupId: number;
	url: string;
};
type FakeGroup = { id: number; windowId: number; title: string };

const state = {
	windows: new Map<number, number[]>(),
	tabs: new Map<number, FakeTab>(),
	groups: [] as FakeGroup[],
	nextGroupId: 1,
};

function indexOf(tabId: number): { windowId: number; index: number } {
	for (const [windowId, ids] of state.windows) {
		const index = ids.indexOf(tabId);
		if (index >= 0) return { windowId, index };
	}
	throw new Error(`tab ${tabId} not in any window`);
}

function view(tab: FakeTab) {
	return { ...tab, ...indexOf(tab.id) };
}

function detach(tabId: number): void {
	const { windowId, index } = indexOf(tabId);
	state.windows.get(windowId)?.splice(index, 1);
}

function insert(tabId: number, windowId: number, index: number): void {
	const ids = state.windows.get(windowId) ?? [];
	state.windows.set(windowId, ids);
	ids.splice(index < 0 ? ids.length : index, 0, tabId);
	const tab = state.tabs.get(tabId);
	if (tab) tab.windowId = windowId;
}

mock.module("wxt/browser", () => ({
	browser: {
		storage: {
			sync: { get: mock(async () => ({ color: "blue" })) },
		},
		tabGroups: {
			TAB_GROUP_ID_NONE: -1,
			update: mock(async (id: number, props: { title?: string }) => {
				const g = state.groups.find((x) => x.id === id);
				if (g && props.title) g.title = props.title;
			}),
			query: mock(async (q: { title?: string }) =>
				state.groups.filter((g) => !q.title || g.title === q.title),
			),
		},
		tabs: {
			group: mock(
				async ({
					tabIds,
					groupId,
				}: {
					tabIds: number[];
					groupId?: number;
				}) => {
					const tab = state.tabs.get(tabIds[0]);
					if (!tab) throw new Error("no tab");
					let id = groupId;
					if (id === undefined) {
						id = state.nextGroupId++;
						state.groups.push({ id, windowId: tab.windowId, title: "" });
					}
					const group = state.groups.find((g) => g.id === id);
					if (group && group.windowId !== tab.windowId) {
						throw new Error("tab and group are in different windows");
					}
					const siblings = state.windows
						.get(tab.windowId)
						?.filter((t) => t !== tab.id && state.tabs.get(t)?.groupId === id);
					detach(tab.id);
					const last = siblings?.length
						? Math.max(...siblings.map((t) => indexOf(t).index))
						: (state.windows.get(tab.windowId)?.length ?? 0) - 1;
					insert(tab.id, tab.windowId, last + 1);
					tab.groupId = id;
					return id;
				},
			),
			get: mock(async (id: number) => {
				const tab = state.tabs.get(id);
				if (!tab) throw new Error("no tab");
				return view(tab);
			}),
			query: mock(async (q: { groupId?: number }) =>
				[...state.tabs.values()]
					.filter((t) => q.groupId === undefined || t.groupId === q.groupId)
					.map(view),
			),
			move: mock(
				async (id: number, p: { windowId?: number; index: number }) => {
					const tab = state.tabs.get(id);
					if (!tab) throw new Error("no tab");
					const windowId = p.windowId ?? tab.windowId;
					if (windowId !== tab.windowId) tab.groupId = -1;
					detach(id);
					insert(id, windowId, p.index);
				},
			),
			update: mock(async (id: number, p: { url?: string }) => {
				const tab = state.tabs.get(id);
				if (tab && p.url) tab.url = p.url;
			}),
		},
	},
}));

import { addGroupMarker } from "../../skills-cli/src/utils/marker";

const { onTabComplete } = await import("@/lib/features/tab-grouping");

function addTab(id: number, windowId: number, url: string, groupId = -1) {
	state.tabs.set(id, { id, windowId, groupId, url });
	insert(id, windowId, -1);
}

function addGroup(id: number, windowId: number, title: string) {
	state.groups.push({ id, windowId, title });
	state.nextGroupId = Math.max(state.nextGroupId, id + 1);
}

function markedTab(
	id: number,
	windowId: number,
	pos: number,
	batch = "b1",
	group = "IP",
) {
	addTab(
		id,
		windowId,
		addGroupMarker(`https://github.com/o/r/pull/${id}`, group, pos, batch),
	);
}

function groupOrder(groupId: number): number[] {
	return [...state.tabs.values()]
		.filter((t) => t.groupId === groupId)
		.sort((a, b) => indexOf(a.id).index - indexOf(b.id).index)
		.map((t) => t.id);
}

beforeEach(() => {
	state.windows.clear();
	state.tabs.clear();
	state.groups = [];
	state.nextGroupId = 1;
});

describe("onTabComplete", () => {
	it("puts concurrently arriving tabs into one group in pos order", async () => {
		for (const [id, pos] of [
			[11, 0],
			[12, 1],
			[13, 2],
		]) {
			markedTab(id, 1, pos);
		}
		await Promise.all([11, 12, 13].map(onTabComplete));

		expect(state.groups).toHaveLength(1);
		expect(state.groups[0].title).toBe("IP");
		expect(groupOrder(state.groups[0].id)).toEqual([11, 12, 13]);
	});

	it("orders tabs by pos when they arrive out of order", async () => {
		for (const [id, pos] of [
			[21, 3],
			[22, 0],
			[23, 2],
			[24, 1],
		]) {
			markedTab(id, 1, pos);
		}
		await Promise.all([21, 22, 23, 24].map(onTabComplete));

		expect(state.groups).toHaveLength(1);
		expect(groupOrder(state.groups[0].id)).toEqual([22, 24, 23, 21]);
	});

	it("reuses an existing group in another window and moves the tab there", async () => {
		addTab(90, 2, "https://example.com/");
		addGroup(5, 2, "IP");
		state.tabs.get(90)!.groupId = 5;
		markedTab(31, 1, 0);
		markedTab(32, 1, 1);
		await Promise.all([31, 32].map(onTabComplete));

		expect(state.groups).toHaveLength(1);
		expect(state.tabs.get(31)?.windowId).toBe(2);
		expect(state.tabs.get(32)?.windowId).toBe(2);
		expect(groupOrder(5)).toEqual([90, 31, 32]);
	});

	it("prefers the group in the tab's own window", async () => {
		addGroup(5, 2, "IP");
		addGroup(6, 1, "IP");
		markedTab(41, 1, 0);
		await onTabComplete(41);

		expect(state.tabs.get(41)?.groupId).toBe(6);
		expect(state.tabs.get(41)?.windowId).toBe(1);
	});

	it("keeps batch tabs together after unrelated tabs already in the group", async () => {
		addGroup(5, 1, "IP");
		addTab(80, 1, "https://example.com/a", 5);
		addTab(81, 1, "https://example.com/b", 5);
		markedTab(51, 1, 1);
		markedTab(52, 1, 0);
		markedTab(53, 1, 2);
		await Promise.all([51, 52, 53].map(onTabComplete));

		expect(state.groups).toHaveLength(1);
		expect(groupOrder(5)).toEqual([80, 81, 52, 51, 53]);
	});

	it("does not mix tabs from two batches", async () => {
		markedTab(61, 1, 0, "old");
		await onTabComplete(61);
		markedTab(62, 1, 1, "new");
		markedTab(63, 1, 0, "new");
		await Promise.all([62, 63].map(onTabComplete));

		expect(groupOrder(state.groups[0].id)).toEqual([61, 63, 62]);
	});

	it("strips every marker from the tab URL", async () => {
		markedTab(71, 1, 0);
		await onTabComplete(71);

		expect(state.tabs.get(71)?.url).toBe("https://github.com/o/r/pull/71");
	});

	it("ignores tabs without a group marker", async () => {
		addTab(72, 1, "https://example.com/");
		await onTabComplete(72);

		expect(state.groups).toHaveLength(0);
		expect(state.tabs.get(72)?.groupId).toBe(-1);
	});
});
