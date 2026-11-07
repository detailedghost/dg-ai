import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	AgentGroupFullError,
	agentGroupIds,
	createAgentTabs,
	groupTitle,
	MAX_AGENT_TABS,
} from "@/lib/background/agent-tabs";
import { GROUP_COLORS } from "@/lib/config";
import {
	agentRecordKey,
	createFakeBrowser,
	createLock,
	type FakeBrowser,
	recordOf,
	tabOf,
	windowOf,
} from "./utils/fake-browser";

let currentBrowser: FakeBrowser["api"];

mock.module("wxt/browser", () => ({
	browser: {
		get storage() {
			return currentBrowser.storage;
		},
		get tabs() {
			return currentBrowser.tabs;
		},
	},
}));

const { registerAgentTabs } = await import("@/lib/background/agent-tabs");

const SESSION_A = "ab12cdef-0001";
const SESSION_B = "cd34ef56-0002";
const URL_A = "https://a.example.test/";

type Seed = Parameters<typeof createFakeBrowser>[0];

function setup(seed: Seed = {}) {
	const fake = createFakeBrowser(seed);
	const agentTabs = createAgentTabs({
		browserApi: fake.api,
		storage: fake.api.storage,
		lock: createLock(),
	});
	const open = (sessionId = SESSION_A, url = URL_A, agentIdentity = "agent") =>
		agentTabs.open({ sessionId, agentIdentity, url });
	return { fake, agentTabs, open };
}

function groupOf(fake: FakeBrowser, tabId: number): number {
	return fake.tabs.get(tabId)?.groupId as number;
}

describe("groupTitle", () => {
	it("joins the identity and the first four session characters", () => {
		expect(groupTitle({ agentIdentity: "agent", sessionId: SESSION_A })).toBe(
			"agent · ab12",
		);
	});

	it("gives two sessions with the default identity two different titles", () => {
		expect(groupTitle({ agentIdentity: "agent", sessionId: SESSION_A })).not.toBe(
			groupTitle({ agentIdentity: "agent", sessionId: SESSION_B }),
		);
	});

	it("cuts a long identity so the title is 40 characters and keeps the suffix", () => {
		const title = groupTitle({
			agentIdentity: "x".repeat(60),
			sessionId: SESSION_A,
		});
		expect(title).toHaveLength(40);
		expect(title.endsWith(" · ab12")).toBe(true);
	});
});

describe("agent tabs open", () => {
	it("creates an inactive tab in a new titled group and stores the record", async () => {
		const { fake, open } = setup();
		const { tabId } = await open();
		const tab = fake.tabs.get(tabId);
		const groupId = groupOf(fake, tabId);
		const title = groupTitle({ agentIdentity: "agent", sessionId: SESSION_A });

		expect(tab?.url).toBe(URL_A);
		expect(tab?.active).toBe(false);
		expect(tab?.autoDiscardable).toBe(false);
		expect(fake.raw.tabs.group.mock.calls[0]?.[0]).toEqual({ tabIds: [tabId] });
		expect(fake.raw.tabGroups.update).toHaveBeenCalledWith(groupId, {
			title,
			color: expect.any(String),
		});
		expect(fake.raw.tabs.group.mock.invocationCallOrder[0]).toBeLessThan(
			fake.raw.tabGroups.update.mock.invocationCallOrder[0] as number,
		);
		expect(fake.record(SESSION_A)).toMatchObject({
			sessionId: SESSION_A,
			agentIdentity: "agent",
			groupId,
			title,
		});
	});

	it("adds the second tab to the same group in the group's window", async () => {
		const { fake, open } = setup({
			windows: [windowOf({ id: 1 }), windowOf({ id: 2, focused: false })],
			lastFocusedWindowId: 2,
		});
		const first = await open();
		const groupId = groupOf(fake, first.tabId);
		fake.state.lastFocusedWindowId = 1;
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(fake.raw.tabs.group.mock.calls[1]?.[0]).toEqual({
			groupId,
			tabIds: [second.tabId],
		});
		expect(fake.tabs.get(second.tabId)?.windowId).toBe(fake.tabs.get(first.tabId)?.windowId);
		expect(fake.groups.size).toBe(1);
	});

	it("gives each agent its own group and its own color", async () => {
		const { fake, open } = setup();
		const a = await open(SESSION_A);
		const b = await open(SESSION_B);

		expect(groupOf(fake, a.tabId)).not.toBe(groupOf(fake, b.tabId));
		expect(fake.record(SESSION_A)?.color).not.toBe(fake.record(SESSION_B)?.color);
		expect(fake.record(SESSION_A)?.title).not.toBe(fake.record(SESSION_B)?.title);
	});

	it("gives distinct colors until every color is used, then reuses colors", async () => {
		const { fake, open } = setup();
		const sessions = Array.from(
			{ length: GROUP_COLORS.length + 1 },
			(_, i) => `s${String(i).padStart(3, "0")}-session`,
		);
		for (const sessionId of sessions) await open(sessionId);
		const colors = sessions.map((id) => fake.record(id)?.color);

		expect(new Set(colors.slice(0, GROUP_COLORS.length)).size).toBe(
			GROUP_COLORS.length,
		);
		expect(GROUP_COLORS).toContain(colors.at(-1) as never);
	});

	it("hands a freed color to the next agent", async () => {
		const { fake, agentTabs, open } = setup();
		await open(SESSION_A);
		await open(SESSION_B);
		const freed = fake.record(SESSION_A)?.color;
		await agentTabs.forget({ sessionId: SESSION_A });
		await open("ef56ab78-0003");

		expect(fake.record("ef56ab78-0003")?.color).toBe(freed);
	});

	it("recreates a group the user removed", async () => {
		const { fake, open } = setup();
		const first = await open();
		const oldGroup = groupOf(fake, first.tabId);
		fake.dropGroup(oldGroup);
		const second = await open(SESSION_A, "https://b.example.test/");
		const newGroup = groupOf(fake, second.tabId);

		expect(newGroup).not.toBe(oldGroup);
		expect(fake.groups.get(newGroup)?.title).toBe(
			groupTitle({ agentIdentity: "agent", sessionId: SESSION_A }),
		);
		expect(fake.record(SESSION_A)?.groupId).toBe(newGroup);
	});

	it("makes one group for two concurrent first opens of one session", async () => {
		const { fake, open } = setup();
		const [a, b] = await Promise.all([
			open(SESSION_A, URL_A),
			open(SESSION_A, "https://b.example.test/"),
		]);

		expect(fake.groups.size).toBe(1);
		expect(groupOf(fake, a.tabId)).toBe(groupOf(fake, b.tabId));
	});

	it("gives two agents that open at once two different colors", async () => {
		const { fake, open } = setup();
		await Promise.all([open(SESSION_A), open(SESSION_B)]);

		expect(fake.record(SESSION_A)?.color).not.toBe(fake.record(SESSION_B)?.color);
	});

	it("never creates a tab in a private window", async () => {
		const { fake, open } = setup({
			windows: [windowOf({ id: 1, incognito: true })],
		});
		const { tabId } = await open();

		expect(fake.raw.windows.create).toHaveBeenCalledWith({
			url: URL_A,
			focused: false,
		});
		expect(fake.windows.get(fake.tabs.get(tabId)?.windowId as number)?.incognito).toBe(
			false,
		);
		for (const [props] of fake.raw.tabs.create.mock.calls)
			expect(props.windowId).not.toBe(1);
	});

	it("recreates the group in a normal window when the user dragged it into a private window", async () => {
		const { fake, open } = setup({
			windows: [windowOf({ id: 1 }), windowOf({ id: 2, incognito: true, focused: false })],
			lastFocusedWindowId: 1,
			tabs: [tabOf({ id: 5, windowId: 2, groupId: 10 })],
			groups: [{ id: 10, windowId: 2, title: "agent · ab12" }],
		});
		fake.seedRecord(
			recordOf({ sessionId: SESSION_A, groupId: 10, color: "green" }),
		);
		const { tabId } = await open();
		const created = fake.tabs.get(tabId);
		const record = fake.record(SESSION_A);

		expect(created?.windowId).toBe(1);
		expect(fake.windows.get(created?.windowId as number)?.incognito).toBe(false);
		for (const [props] of fake.raw.tabs.create.mock.calls)
			expect(props.windowId).toBe(1);
		for (const [options] of fake.raw.tabs.group.mock.calls)
			expect(options.groupId).not.toBe(10);
		expect(record?.groupId).toBe(groupOf(fake, tabId));
		expect(record?.groupId).not.toBe(10);
		expect(record?.color).toBe("green");
	});

	it("removes the new tab and stores no record when the first grouping rejects", async () => {
		const { fake, open } = setup();
		fake.raw.tabs.group.mockImplementationOnce(async () => {
			throw new Error("grouping failed");
		});

		await expect(open()).rejects.toThrow("grouping failed");
		const created = (await fake.raw.tabs.create.mock.results[0]?.value) as {
			id: number;
		};
		expect(fake.raw.tabs.remove).toHaveBeenCalledWith(created.id);
		expect(fake.tabs.has(created.id)).toBe(false);
		expect(fake.record(SESSION_A)).toBeUndefined();
	});

	it("removes the new tab and stores no record when the group title update rejects", async () => {
		const { fake, open } = setup();
		fake.raw.tabGroups.update.mockImplementationOnce(async () => {
			throw new Error("title failed");
		});

		await expect(open()).rejects.toThrow("title failed");
		const created = (await fake.raw.tabs.create.mock.results[0]?.value) as {
			id: number;
		};
		expect(fake.raw.tabs.remove).toHaveBeenCalledWith(created.id);
		expect(fake.tabs.has(created.id)).toBe(false);
		expect(fake.groups.size).toBe(0);
		expect(fake.record(SESSION_A)).toBeUndefined();
	});

	it("removes only the new tab when joining the existing group rejects", async () => {
		const { fake, open } = setup();
		const first = await open();
		fake.raw.tabs.group.mockImplementationOnce(async () => {
			throw new Error("join failed");
		});

		await expect(open(SESSION_A, "https://b.example.test/")).rejects.toThrow(
			"join failed",
		);
		const second = (await fake.raw.tabs.create.mock.results[1]?.value) as {
			id: number;
		};
		expect(fake.raw.tabs.remove).toHaveBeenCalledTimes(1);
		expect(fake.raw.tabs.remove).toHaveBeenCalledWith(second.id);
		expect(fake.tabs.has(first.tabId)).toBe(true);
		expect(fake.record(SESSION_A)?.groupId).toBe(groupOf(fake, first.tabId));
	});

	it("refuses a tab beyond the group limit, counting every tab in the group", async () => {
		const { fake, open } = setup();
		const first = await open();
		const groupId = groupOf(fake, first.tabId);
		const windowId = fake.tabs.get(first.tabId)?.windowId as number;
		for (let i = 0; i < MAX_AGENT_TABS - 1; i++)
			fake.addTab({
				id: 2000 + i,
				windowId,
				groupId,
				incognito: i === 0,
			});

		await expect(open(SESSION_A, "https://b.example.test/")).rejects.toBeInstanceOf(
			AgentGroupFullError,
		);
		expect(fake.raw.tabs.create).toHaveBeenCalledTimes(1);
		expect(fake.tabsInGroup(groupId)).toHaveLength(MAX_AGENT_TABS);
	});

	it("lets exactly one of two concurrent opens take the last slot", async () => {
		const { fake, open } = setup();
		const first = await open();
		const groupId = groupOf(fake, first.tabId);
		const windowId = fake.tabs.get(first.tabId)?.windowId as number;
		for (let i = 0; i < MAX_AGENT_TABS - 2; i++)
			fake.addTab({ id: 2000 + i, windowId, groupId });

		const results = await Promise.allSettled([
			open(SESSION_A, "https://b.example.test/"),
			open(SESSION_A, "https://c.example.test/"),
		]);

		expect(results.map((result) => result.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(fake.tabsInGroup(groupId)).toHaveLength(MAX_AGENT_TABS);
	});

	it("uses the last focused normal window when the group is gone", async () => {
		const { fake, open } = setup({
			windows: [windowOf({ id: 1 }), windowOf({ id: 2, focused: false })],
			lastFocusedWindowId: 1,
		});
		const first = await open();
		fake.dropGroup(groupOf(fake, first.tabId));
		fake.state.lastFocusedWindowId = 2;
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(fake.tabs.get(second.tabId)?.windowId).toBe(2);
	});
});

describe("agent tabs selection", () => {
	async function withTabs(count: number) {
		const ctx = setup();
		const ids: number[] = [];
		for (let i = 0; i < count; i++)
			ids.push((await ctx.open(SESSION_A, `https://t${i}.example.test/`)).tabId);
		return { ...ctx, ids };
	}

	it("returns no selected tab before any select", async () => {
		const { agentTabs } = await withTabs(1);

		expect(await agentTabs.selected({ sessionId: SESSION_A })).toBeUndefined();
	});

	it("selects a tab without activating it", async () => {
		const { fake, agentTabs, ids } = await withTabs(2);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[1] as number });

		expect((await agentTabs.selected({ sessionId: SESSION_A }))?.tabId).toBe(ids[1]);
		expect(fake.tabs.get(ids[1] as number)?.active).toBe(false);
		for (const [, props] of fake.raw.tabs.update.mock.calls)
			expect(props).not.toHaveProperty("active");
	});

	it("clears the selection when the selected tab is gone", async () => {
		const { fake, agentTabs, ids } = await withTabs(2);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		fake.removeTab(ids[0] as number);

		expect(await agentTabs.selected({ sessionId: SESSION_A })).toBeUndefined();
		expect(fake.record(SESSION_A)?.selectedTabId).toBeUndefined();
	});

	it("clears the selection when the selected tab left the group", async () => {
		const { fake, agentTabs, ids } = await withTabs(2);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		const tab = fake.tabs.get(ids[0] as number);
		if (tab) tab.groupId = -1;

		expect(await agentTabs.selected({ sessionId: SESSION_A })).toBeUndefined();
		expect(fake.record(SESSION_A)?.selectedTabId).toBeUndefined();
	});

	it("refuses to select a tab outside the group and keeps the selection", async () => {
		const { fake, agentTabs, ids, open } = await withTabs(1);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		const other = await open(SESSION_B);
		const loose = fake.addTab({ id: 901, windowId: 1, groupId: -1 });

		for (const tabId of [other.tabId, loose.id, 424242])
			await expect(agentTabs.select({ sessionId: SESSION_A, tabId })).rejects.toThrow(
				"is not in this agent's tab group",
			);
		expect(fake.record(SESSION_A)?.selectedTabId).toBe(ids[0]);
	});

	it("lists only the group's tabs with selected and active flags", async () => {
		const { fake, agentTabs, ids } = await withTabs(2);
		fake.addTab({ id: 900, windowId: 1, groupId: -1, title: "Mine" });
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[1] as number });
		const tab = fake.tabs.get(ids[0] as number);
		if (tab) tab.active = true;
		const rows = await agentTabs.list({ sessionId: SESSION_A });

		expect(rows.map((row) => row.tabId).sort()).toEqual([...ids].sort());
		expect(rows.find((row) => row.tabId === ids[1])).toMatchObject({
			selected: true,
			active: false,
			url: "https://t1.example.test/",
		});
		expect(rows.find((row) => row.tabId === ids[0])).toMatchObject({
			selected: false,
			active: true,
		});
	});

	it("lists nothing for a session with no record", async () => {
		const { agentTabs } = setup();

		expect(await agentTabs.list({ sessionId: SESSION_A })).toEqual([]);
	});
});

describe("agent tabs close", () => {
	async function withTabs(count: number) {
		const ctx = setup();
		const ids: number[] = [];
		for (let i = 0; i < count; i++)
			ids.push((await ctx.open(SESSION_A, `https://t${i}.example.test/`)).tabId);
		return { ...ctx, ids };
	}

	it("moves the selection to the group's last tab when the selected tab closes", async () => {
		const { fake, agentTabs, ids } = await withTabs(3);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		const result = await agentTabs.close({
			sessionId: SESSION_A,
			tabId: ids[0] as number,
		});

		expect(fake.tabs.has(ids[0] as number)).toBe(false);
		expect(result).toEqual({ selectedTabId: ids[2] });
		expect((await agentTabs.selected({ sessionId: SESSION_A }))?.tabId).toBe(ids[2]);
	});

	it("keeps the selection when another tab closes", async () => {
		const { agentTabs, ids } = await withTabs(2);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		const result = await agentTabs.close({
			sessionId: SESSION_A,
			tabId: ids[1] as number,
		});

		expect(result.selectedTabId).toBeUndefined();
		expect((await agentTabs.selected({ sessionId: SESSION_A }))?.tabId).toBe(ids[0]);
	});

	it("closes the selected tab when no tab id is given", async () => {
		const { fake, agentTabs, ids } = await withTabs(2);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[1] as number });
		await agentTabs.close({ sessionId: SESSION_A });

		expect(fake.tabs.has(ids[1] as number)).toBe(false);
	});

	it("refuses to close a tab outside the group and leaves it open", async () => {
		const { fake, agentTabs, ids, open } = await withTabs(1);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		const other = await open(SESSION_B);
		const loose = fake.addTab({ id: 901, windowId: 1, groupId: -1 });

		for (const tabId of [other.tabId, loose.id])
			await expect(agentTabs.close({ sessionId: SESSION_A, tabId })).rejects.toThrow(
				"is not in this agent's tab group",
			);
		expect(fake.raw.tabs.remove).not.toHaveBeenCalled();
		expect(fake.tabs.has(other.tabId)).toBe(true);
		expect(fake.tabs.has(loose.id)).toBe(true);
		expect(fake.record(SESSION_A)?.selectedTabId).toBe(ids[0]);
	});

	it.each([
		["a loose tab", () => -1],
		["another agent's group", (otherGroup: number) => otherGroup],
	])(
		"refuses to close a stored selection that moved into %s",
		async (_name, destination) => {
			const { fake, agentTabs, ids, open } = await withTabs(2);
			await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
			const other = await open(SESSION_B);
			const moved = fake.tabs.get(ids[0] as number);
			if (moved) moved.groupId = destination(groupOf(fake, other.tabId));

			await expect(agentTabs.close({ sessionId: SESSION_A })).rejects.toThrow(
				"is not in this agent's tab group",
			);
			expect(fake.raw.tabs.remove).not.toHaveBeenCalled();
			expect(fake.tabs.has(ids[0] as number)).toBe(true);
		},
	);

	it("clears the selection when the last tab closes", async () => {
		const { fake, agentTabs, ids } = await withTabs(1);
		await agentTabs.select({ sessionId: SESSION_A, tabId: ids[0] as number });
		const result = await agentTabs.close({ sessionId: SESSION_A });

		expect(result.selectedTabId).toBeUndefined();
		expect(await agentTabs.selected({ sessionId: SESSION_A })).toBeUndefined();
		expect(fake.record(SESSION_A)?.selectedTabId).toBeUndefined();
	});
});

describe("agent tabs ownership", () => {
	it("owns a tab in the group and no other tab", async () => {
		const { fake, agentTabs, open } = setup();
		const { tabId } = await open(SESSION_A);
		const other = await open(SESSION_B);
		const loose = fake.addTab({ id: 901, windowId: 1, groupId: -1 });

		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId })).toBe(true);
		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId: other.tabId })).toBe(false);
		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId: loose.id })).toBe(false);
		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId: 424242 })).toBe(false);
	});

	it("owns nothing for a session with no record", async () => {
		const { fake, agentTabs } = setup({ tabs: [tabOf({ id: 5, groupId: 10 })] });

		expect(fake.record(SESSION_A)).toBeUndefined();
		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId: 5 })).toBe(false);
	});
});

describe("agent tabs forget", () => {
	it("drops the record and leaves the tabs and the group alone", async () => {
		const { fake, agentTabs, open } = setup();
		const { tabId } = await open();
		const groupId = groupOf(fake, tabId);
		await agentTabs.forget({ sessionId: SESSION_A });

		expect(fake.record(SESSION_A)).toBeUndefined();
		expect(fake.tabs.get(tabId)?.groupId).toBe(groupId);
		expect(fake.groups.has(groupId)).toBe(true);
		expect(fake.raw.tabs.remove).not.toHaveBeenCalled();
	});
});

describe("agentGroupIds", () => {
	it("returns the group id of every agent record", async () => {
		const { fake } = setup();
		fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10 }));
		fake.seedRecord(recordOf({ sessionId: SESSION_B, groupId: 11 }));
		fake.session.set("tab_group_marked:7", true);

		expect(await agentGroupIds({ storage: fake.api.storage })).toEqual(
			new Set([10, 11]),
		);
	});

	it("lists the group an open created", async () => {
		const { fake, open } = setup();
		await open(SESSION_A);

		expect((await agentGroupIds({ storage: fake.api.storage })).size).toBe(1);
	});

	it("returns an empty set when no agent record exists", async () => {
		const { fake } = setup();
		fake.session.set("tab_group_marked:7", true);

		expect(await agentGroupIds({ storage: fake.api.storage })).toEqual(new Set());
	});
});

describe("registerAgentTabs", () => {
	const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

	afterEach(() => {
		if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
		else Reflect.deleteProperty(navigator, "locks");
	});

	function register(seed: Seed = {}) {
		const fake = createFakeBrowser(seed);
		currentBrowser = fake.api;
		Object.defineProperty(navigator, "locks", {
			value: createLock(),
			configurable: true,
		});
		registerAgentTabs();
		return fake;
	}

	const settle = () => Bun.sleep(0);

	it("clears the stored selection when the selected tab is removed", async () => {
		const fake = register({
			tabs: [
				tabOf({ id: 5, groupId: 10 }),
				tabOf({ id: 6, groupId: 10 }),
			],
			groups: [{ id: 10, windowId: 1, title: "agent · ab12" }],
		});
		fake.seedRecord(
			recordOf({ sessionId: SESSION_A, groupId: 10, selectedTabId: 5 }),
		);

		fake.removeTab(5);
		await settle();

		expect(fake.record(SESSION_A)?.selectedTabId).toBeUndefined();
		expect(fake.record(SESSION_A)?.groupId).toBe(10);
	});

	it("keeps the stored selection when an unrelated tab is removed", async () => {
		const fake = register({
			tabs: [
				tabOf({ id: 5, groupId: 10 }),
				tabOf({ id: 6, groupId: 10 }),
			],
			groups: [{ id: 10, windowId: 1, title: "agent · ab12" }],
		});
		fake.seedRecord(
			recordOf({ sessionId: SESSION_A, groupId: 10, selectedTabId: 5 }),
		);

		fake.removeTab(6);
		await settle();

		expect(fake.record(SESSION_A)?.selectedTabId).toBe(5);
	});
});
