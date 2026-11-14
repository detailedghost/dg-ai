import { afterEach, describe, expect, it, mock } from "bun:test";
import { CHAT_DEFAULT_PORT } from "@dg/common";
import { MSG } from "@dg/pages/chat-messages";
import {
	AgentGroupFullError,
	agentGroupIds,
	agentSessionIds,
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
import { makeLocalArea } from "./utils/relay-harness";

type Listener = (
	message: unknown,
	sender: unknown,
	sendResponse: (reply: unknown) => void,
) => boolean | undefined;

let currentBrowser: FakeBrowser["api"];
let currentLocal = makeLocalArea();
let currentListeners = new Set<Listener>();
let currentStartup = new Set<() => void>();
let currentGroupRemoved = new Set<(group: { id: number }) => void>();

const EXTENSION_ID = "ext-self";

mock.module("wxt/browser", () => ({
	browser: {
		get storage() {
			return { session: currentBrowser.storage.session, local: currentLocal };
		},
		get tabs() {
			return currentBrowser.tabs;
		},
		get windows() {
			return currentBrowser.windows;
		},
		get tabGroups() {
			return {
				...currentBrowser.tabGroups,
				onRemoved: {
					addListener: (fn: (group: { id: number }) => void) =>
						currentGroupRemoved.add(fn),
				},
				onCreated: { addListener: () => undefined },
				onUpdated: { addListener: () => undefined },
				onMoved: { addListener: () => undefined },
			};
		},
		get runtime() {
			return {
				id: EXTENSION_ID,
				onMessage: {
					addListener: (fn: Listener) => currentListeners.add(fn),
				},
				onStartup: {
					addListener: (fn: () => void) => currentStartup.add(fn),
				},
			};
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
		expect(fake.raw.tabs.group.mock.calls[0]?.[0]).toEqual({
			tabIds: [tabId],
			createProperties: { windowId: tab?.windowId as number },
		});
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

	it("reuses the group after a reload cleared the session record", async () => {
		const { fake, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.reload();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(groupOf(fake, second.tabId)).toBe(group);
		expect(fake.groups.size).toBe(1);
		expect(fake.record(SESSION_A)?.groupId).toBe(group);
	});

	it("does not match a group by title when no group id was saved", async () => {
		const title = groupTitle({ agentIdentity: "agent", sessionId: SESSION_A });
		const { fake, open } = setup({
			tabs: [tabOf({ id: 7, groupId: 40 })],
			groups: [{ id: 40, windowId: 1, title }],
		});
		const { tabId } = await open();

		expect(groupOf(fake, tabId)).not.toBe(40);
		expect(fake.groups.size).toBe(2);
	});

	it("restores saved records into session storage and reports their tabs", async () => {
		const { fake, agentTabs, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.reload();

		expect(await agentTabs.restore()).toEqual([first.tabId]);
		expect(fake.record(SESSION_A)?.groupId).toBe(group);
		expect(await agentSessionIds({ storage: fake.api.storage })).toEqual(
			new Set([SESSION_A]),
		);
	});

	it("drops a saved record whose group is gone when it restores", async () => {
		const { fake, agentTabs, open } = setup();
		const first = await open();
		fake.dropGroup(groupOf(fake, first.tabId));
		fake.reload();

		expect(await agentTabs.restore()).toEqual([]);
		expect(fake.record(SESSION_A)).toBeUndefined();
	});

	it("adopts no person-made group whose id matches a record saved before a browser restart", async () => {
		const { fake, agentTabs, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.tabs.clear();
		fake.groups.clear();
		fake.addTab({ id: 900, groupId: group });
		fake.addGroup({ id: group, windowId: 1, title: "Reading list" });
		fake.reload();

		expect(await agentTabs.restore()).toEqual([]);
		expect(fake.record(SESSION_A)).toBeUndefined();
		expect(agentTabs.list({ sessionId: SESSION_A })).resolves.toEqual([]);
		const next = await open(SESSION_A, "https://b.example.test/");
		expect(groupOf(fake, next.tabId)).not.toBe(group);
	});

	it("drops saved records of sessions that are not paired when it restores", async () => {
		const { fake, agentTabs, open } = setup();
		await open(SESSION_A);
		await open(SESSION_B);
		fake.reload();

		await agentTabs.restore({ paired: new Set([SESSION_B]) });

		expect(fake.record(SESSION_A)).toBeUndefined();
		expect(fake.record(SESSION_B)).toBeDefined();
		fake.reload();
		await agentTabs.restore();
		expect(fake.record(SESSION_A)).toBeUndefined();
	});

	it("reuses a group the person moved to another window", async () => {
		const { fake, agentTabs, open } = setup({
			windows: [windowOf({ id: 1 }), windowOf({ id: 2, focused: false })],
		});
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.groups.get(group)!.windowId = 2;
		fake.tabs.get(first.tabId)!.windowId = 2;
		await agentTabs.groupChanged({ groupId: group });
		fake.reload();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(groupOf(fake, second.tabId)).toBe(group);
	});

	it("does not adopt a group whose title no longer matches the saved one", async () => {
		const { fake, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.groups.get(group)!.title = "Reading list";
		fake.reload();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(groupOf(fake, second.tabId)).not.toBe(group);
	});

	it("keeps the record when Chrome re-creates the group in another window", async () => {
		const fake = createFakeBrowser({
			windows: [windowOf({ id: 1 }), windowOf({ id: 2, focused: false })],
		});
		const agentTabs = createAgentTabs({
			browserApi: fake.api,
			storage: fake.api.storage,
			lock: createLock(),
			graceMs: 200,
		});
		const first = await agentTabs.open({ sessionId: SESSION_A, agentIdentity: "agent", url: URL_A });
		const group = groupOf(fake, first.tabId);

		const removed = agentTabs.groupRemoved({ groupId: group });
		fake.groups.get(group)!.windowId = 2;
		fake.tabs.get(first.tabId)!.windowId = 2;
		agentTabs.groupCreated({ groupId: group });
		await removed;

		expect(fake.record(SESSION_A)?.groupId).toBe(group);
		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId: first.tabId })).toBe(true);
		const second = await agentTabs.open({
			sessionId: SESSION_A,
			agentIdentity: "agent",
			url: "https://b.example.test/",
		});
		expect(groupOf(fake, second.tabId)).toBe(group);
		expect(fake.groups.size).toBe(1);
		await agentTabs.restore();
		fake.reload();
		expect(await agentTabs.restore()).toEqual([first.tabId, second.tabId]);
	});

	it("drops the record when no group with that id comes back in time", async () => {
		const fake = createFakeBrowser();
		const agentTabs = createAgentTabs({
			browserApi: fake.api,
			storage: fake.api.storage,
			lock: createLock(),
			graceMs: 20,
		});
		const first = await agentTabs.open({ sessionId: SESSION_A, agentIdentity: "agent", url: URL_A });
		const group = groupOf(fake, first.tabId);
		fake.dropGroup(group);

		await agentTabs.groupRemoved({ groupId: group });

		expect(fake.record(SESSION_A)).toBeUndefined();
		await agentTabs.restore();
		expect(fake.record(SESSION_A)).toBeUndefined();
	});

	it("reports the tabs of a recovered group", async () => {
		const { fake, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.reload();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(group).toBe(groupOf(fake, second.tabId));
		expect(second.recoveredTabIds).toEqual([first.tabId]);
	});

	it("reuses a renamed group through the saved group id", async () => {
		const { fake, agentTabs, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.groups.get(group)!.title = "my rename";
		await agentTabs.groupChanged({ groupId: group });
		fake.reload();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(groupOf(fake, second.tabId)).toBe(group);
		expect(fake.groups.size).toBe(1);
	});

	it("does not reuse another session's group or a group the person made", async () => {
		const { fake, open } = setup({
			tabs: [tabOf({ id: 7, groupId: 40 }), tabOf({ id: 8, groupId: 41 })],
			groups: [
				{
					id: 40,
					windowId: 1,
					title: groupTitle({ agentIdentity: "agent", sessionId: SESSION_B }),
				},
				{ id: 41, windowId: 1, title: "Reading list" },
			],
		});
		const { tabId } = await open();

		expect([40, 41]).not.toContain(groupOf(fake, tabId));
		expect(fake.groups.size).toBe(3);
	});

	it("does not take a group that another session's record holds", async () => {
		const { fake, open } = setup();
		const first = await open(SESSION_A);
		const group = groupOf(fake, first.tabId);
		fake.groups.get(group)!.title = groupTitle({
			agentIdentity: "agent",
			sessionId: SESSION_B,
		});
		const { tabId } = await open(SESSION_B);

		expect(groupOf(fake, tabId)).not.toBe(group);
	});

	it("does not take a group saved for another session with the same title", async () => {
		const { fake, open } = setup();
		const first = await open(SESSION_A);
		const group = groupOf(fake, first.tabId);
		fake.reload();
		const { tabId } = await open("ab12cdef-9999");

		expect(groupOf(fake, tabId)).not.toBe(group);
	});

	it("forgets saved groups when the browser starts", async () => {
		const { fake, agentTabs, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.groups.get(group)!.title = "my rename";
		await agentTabs.groupChanged({ groupId: group });
		fake.reload();
		await agentTabs.clearAll();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(groupOf(fake, second.tabId)).not.toBe(group);
	});

	it("makes a new group after a reload when the saved group is gone", async () => {
		const { fake, open } = setup();
		const first = await open();
		const group = groupOf(fake, first.tabId);
		fake.dropGroup(group);
		fake.reload();
		const second = await open(SESSION_A, "https://b.example.test/");

		expect(groupOf(fake, second.tabId)).not.toBe(group);
		expect(fake.record(SESSION_A)?.groupId).toBe(groupOf(fake, second.tabId));
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

describe("agent tabs browser removals", () => {
	function lockedSetup() {
		const fake = createFakeBrowser({
			tabs: [tabOf({ id: 5, groupId: 10 }), tabOf({ id: 6, groupId: 10 })],
			groups: [{ id: 10, windowId: 1, title: "agent · ab12" }],
		});
		const lock = createLock();
		const request = mock(lock.request.bind(lock));
		const agentTabs = createAgentTabs({
			browserApi: fake.api,
			storage: fake.api.storage,
			lock: { request } as typeof lock,
		});
		fake.seedRecord(
			recordOf({ sessionId: SESSION_A, groupId: 10, selectedTabId: 5 }),
		);
		return { fake, agentTabs, request };
	}

	it("clears a stored selection through the injected lock when its tab is removed", async () => {
		const { fake, agentTabs, request } = lockedSetup();

		await agentTabs.tabRemoved({ tabId: 5 });

		expect(request).toHaveBeenCalledTimes(1);
		expect(fake.record(SESSION_A)?.selectedTabId).toBeUndefined();
		expect(fake.record(SESSION_A)?.groupId).toBe(10);
	});

	it("keeps the selection when another tab is removed", async () => {
		const { fake, agentTabs } = lockedSetup();

		await agentTabs.tabRemoved({ tabId: 6 });

		expect(fake.record(SESSION_A)?.selectedTabId).toBe(5);
	});

	it("drops the record through the injected lock when its group is removed", async () => {
		const { fake, agentTabs, request } = lockedSetup();

		await agentTabs.groupRemoved({ groupId: 10 });

		expect(request).toHaveBeenCalledTimes(1);
		expect(fake.record(SESSION_A)).toBeUndefined();
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
		currentListeners = new Set();
		currentGroupRemoved = new Set();
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


const BOOTSTRAP = {
	port: CHAT_DEFAULT_PORT,
	token: "tok-secret-value",
};

function pairingKey(sessionId: string) {
	return `pairing:${sessionId}`;
}

function holdPairing(sessionId: string, agentIdentity = "agent") {
	currentLocal.data[pairingKey(sessionId)] = {
		...BOOTSTRAP,
		sessionId,
		agentIdentity,
		daemonId: "daemon-test",
	};
}

type Reply = { handled: boolean | undefined; reply?: Record<string, unknown> };

describe("agent tabs messages", () => {
	const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

	afterEach(() => {
		if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
		else Reflect.deleteProperty(navigator, "locks");
	});

	function boot(
		seed: Seed = {},
		options: {
			busy?: (arg: { sessionId: string }) => boolean;
			held?: string[];
			onAdopted?: (tabId: number) => void;
		} = {},
	) {
		const fake = createFakeBrowser(seed);
		currentBrowser = fake.api;
		currentLocal = makeLocalArea();
		currentListeners = new Set();
		currentGroupRemoved = new Set();
		Object.defineProperty(navigator, "locks", {
			value: createLock(),
			configurable: true,
		});
		for (const sessionId of options.held ?? [SESSION_A, SESSION_B])
			holdPairing(sessionId, `agent-${sessionId.slice(0, 2)}`);
		registerAgentTabs({
			...(options.busy ? { busy: options.busy } : {}),
			...(options.onAdopted ? { onAdopted: options.onAdopted } : {}),
		});
		const [listener] = [...currentListeners];
		const send = (
			message: unknown,
			sender: unknown = { id: EXTENSION_ID },
		): Promise<Reply> =>
			new Promise((resolve) => {
				const handled = (listener as Listener)(message, sender, (reply) =>
					resolve({ handled, reply: reply as Record<string, unknown> }),
				);
				if (handled !== true) resolve({ handled });
			});
		const adopt = (sessionId: string, tabId: number, agentIdentity = "agent", sender?: unknown) =>
			send({ type: MSG.agentTabAdopt, sessionId, agentIdentity, tabId }, sender);
		const list = (sender?: unknown) =>
			send({ type: MSG.agentTabsRequest }, sender);
		return { fake, send, adopt, list };
	}


	it("registers exactly one runtime message listener", () => {
		boot();

		expect(currentListeners.size).toBe(1);
	});

	describe("list", () => {
		it("returns one group per record with its tabs and the selected flag", async () => {
			const { fake, list } = boot({
				tabs: [
					tabOf({ id: 5, groupId: 10, title: "Five", url: "https://five.example.test/" }),
					tabOf({ id: 6, groupId: 10 }),
					tabOf({ id: 8, groupId: 11 }),
					tabOf({ id: 9 }),
				],
				groups: [
					{ id: 10, windowId: 1, title: "t", color: "blue" },
					{ id: 11, windowId: 1, title: "t", color: "green" },
				],
			});
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10, selectedTabId: 6 }));
			fake.seedRecord(recordOf({ sessionId: SESSION_B, groupId: 11, color: "green" }));

			const { handled, reply } = await list();
			const groups = (reply?.groups as Array<{ sessionId: string; tabs: Array<Record<string, unknown>> }>).slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId));

			expect(handled).toBe(true);
			expect(groups.map((group) => group.sessionId)).toEqual([SESSION_A, SESSION_B]);
			expect(groups[0]?.tabs.map((tab) => [tab.tabId, tab.selected])).toEqual([
				[5, false],
				[6, true],
			]);
			expect(groups[0]?.tabs[0]).toMatchObject({
				title: "Five",
				url: "https://five.example.test/",
			});
			expect(groups[1]?.tabs.map((tab) => tab.tabId)).toEqual([8]);
		});

		it("leaves incognito tabs out of a group's rows", async () => {
			const { fake, list } = boot({
				windows: [windowOf({ id: 1 }), windowOf({ id: 2, incognito: true })],
				tabs: [
					tabOf({ id: 5, groupId: 10 }),
					tabOf({ id: 6, groupId: 10, windowId: 2, incognito: true }),
				],
				groups: [{ id: 10, windowId: 1, title: "t", color: "blue" }],
			});
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10 }));

			const { reply } = await list();

			const [group] = reply?.groups as Array<{ tabs: Array<{ tabId: number }> }>;
			expect(group?.tabs.map((tab) => tab.tabId)).toEqual([5]);
		});

		it("reads the color from the live group when the user recolored it", async () => {
			const { fake, list } = boot({
				tabs: [tabOf({ id: 5, groupId: 10 })],
				groups: [{ id: 10, windowId: 1, title: "t", color: "red" }],
			});
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10, color: "blue" }));

			const { reply } = await list();

			expect((reply?.groups as Array<{ color: string }>)[0]?.color).toBe("red");
		});

		it("returns no tabs and keeps the record color for a group that is gone, without recreating it", async () => {
			const { fake, list } = boot();
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 77, color: "pink" }));

			const { reply } = await list();

			expect(reply?.groups).toEqual([{ sessionId: SESSION_A, color: "pink", tabs: [] }]);
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.raw.tabGroups.update).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)?.groupId).toBe(77);
		});

		it("returns an empty list when no agent has a record", async () => {
			const { list } = boot();

			expect((await list()).reply).toEqual({ groups: [] });
		});
	});

	describe("adopt", () => {
		const plain = (id: number, overrides: Partial<Parameters<typeof tabOf>[0]> = {}) =>
			tabOf({ id, url: `https://page-${id}.example.test/`, ...overrides });

		it("groups the tab into a new group for the session, selects it and replies ok", async () => {
			const { fake, adopt } = boot({ tabs: [plain(5)] });
			holdPairing(SESSION_A, "claude");

			const { reply } = await adopt(SESSION_A, 5, "claude");

			expect(reply).toEqual({ ok: true });
			const record = fake.record(SESSION_A);
			expect(record).toMatchObject({
				sessionId: SESSION_A,
				agentIdentity: "claude",
				selectedTabId: 5,
				title: groupTitle({ agentIdentity: "claude", sessionId: SESSION_A }),
			});
			expect(groupOf(fake, 5)).toBe(record?.groupId as number);
			expect(fake.groups.get(record?.groupId as number)?.title).toBe(record?.title as string);
		});

		it("reports the adopted tab once its record is saved", async () => {
			const adopted: number[] = [];
			const { fake, adopt } = boot({ tabs: [plain(5)] }, { onAdopted: (tabId) => adopted.push(fake.record(SESSION_A) ? tabId : -1) });
			holdPairing(SESSION_A, "claude");
			await adopt(SESSION_A, 5, "claude");
			expect(adopted).toEqual([5]);
		});

		it("names the group after the held pairing, not the identity in the message", async () => {
			const { fake, adopt } = boot({ tabs: [plain(5)] });
			holdPairing(SESSION_A, "claude");

			const { reply } = await adopt(SESSION_A, 5, "spoofed");

			expect(reply).toEqual({ ok: true });
			expect(fake.record(SESSION_A)).toMatchObject({
				agentIdentity: "claude",
				title: groupTitle({ agentIdentity: "claude", sessionId: SESSION_A }),
			});
		});

		it("joins the existing group of the session and moves the selection to the tab", async () => {
			const { fake, adopt } = boot({
				tabs: [plain(5, { groupId: 10 }), plain(6)],
				groups: [{ id: 10, windowId: 1, title: "t", color: "blue" }],
			});
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10, selectedTabId: 5 }));

			const { reply } = await adopt(SESSION_A, 6);

			expect(reply).toEqual({ ok: true });
			expect(groupOf(fake, 6)).toBe(10);
			expect(fake.record(SESSION_A)?.selectedTabId).toBe(6);
			expect(fake.groups.size).toBe(1);
		});

		it("selects a tab already in the group without calling tabs.group", async () => {
			const { fake, adopt } = boot({
				tabs: [plain(5, { groupId: 10 }), plain(6, { groupId: 10 })],
				groups: [{ id: 10, windowId: 1, title: "t", color: "blue" }],
			});
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10, selectedTabId: 5 }));

			const { reply } = await adopt(SESSION_A, 6);

			expect(reply).toEqual({ ok: true });
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)?.selectedTabId).toBe(6);
		});

		it("replies tab not found for a tab id that no longer exists and changes nothing", async () => {
			const { fake, adopt } = boot();

			const { reply } = await adopt(SESSION_A, 999);

			expect(reply).toEqual({ ok: false, error: "tab not found" });
			expect(fake.record(SESSION_A)).toBeUndefined();
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
		});

		it("refuses an incognito tab", async () => {
			const { fake, adopt } = boot({
				windows: [windowOf({ id: 1 }), windowOf({ id: 2, incognito: true })],
				tabs: [plain(5, { windowId: 2, incognito: true })],
			});

			const { reply } = await adopt(SESSION_A, 5);

			expect(reply).toEqual({ ok: false, error: "incognito tabs cannot be shared" });
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)).toBeUndefined();
		});

		it.each([
			["a browser settings page", "chrome://extensions/"],
			["about:blank", "about:blank"],
			["an extension page", "chrome-extension://abcdefghijklmnop/popup.html"],
			["a web store page", "https://chromewebstore.google.com/detail/x"],
			["the Proton Mail tab", "https://mail.proton.me/u/0/inbox"],
		])("refuses %s as a disallowed page", async (_name, url) => {
			const { fake, adopt } = boot({ tabs: [plain(5, { url })] });

			const { reply } = await adopt(SESSION_A, 5);

			expect(reply).toEqual({
				ok: false,
				error: "this page cannot be shared with an agent",
			});
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)).toBeUndefined();
		});

		it("refuses a session that holds no pairing", async () => {
			const { fake, adopt } = boot({ tabs: [plain(5)] }, { held: [SESSION_B] });

			const { reply } = await adopt(SESSION_A, 5);

			expect(reply?.ok).toBe(false);
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)).toBeUndefined();
		});

		describe("a tab in another agent's group", () => {
			const world = (): Seed => ({
				tabs: [
					plain(5, { groupId: 10 }),
					plain(6, { groupId: 10 }),
					plain(8, { groupId: 11 }),
				],
				groups: [
					{ id: 10, windowId: 1, title: "t", color: "blue" },
					{ id: 11, windowId: 1, title: "t", color: "red" },
				],
			});
			const seedOwners = (fake: FakeBrowser) => {
				fake.seedRecord(
					recordOf({
						sessionId: SESSION_A,
						agentIdentity: "owner",
						groupId: 10,
						selectedTabId: 5,
					}),
				);
				fake.seedRecord(
					recordOf({ sessionId: SESSION_B, groupId: 11, selectedTabId: 8, color: "red" }),
				);
			};

			it("is refused with the owner's name and moves nothing when the owner is busy", async () => {
				const busy = mock((_arg: { sessionId: string }) => true);
				const { fake, adopt } = boot(world(), { busy });
				seedOwners(fake);
				const before = [fake.record(SESSION_A), fake.record(SESSION_B)];

				const { reply } = await adopt(SESSION_B, 5);

				expect(reply).toEqual({ ok: false, error: "owner is using this tab" });
				expect(busy).toHaveBeenCalledWith({ sessionId: SESSION_A });
				expect(groupOf(fake, 5)).toBe(10);
				expect(fake.raw.tabs.group).not.toHaveBeenCalled();
				expect([fake.record(SESSION_A), fake.record(SESSION_B)]).toEqual(before);
			});

			it("moves when the owner is not busy and updates both records", async () => {
				const { fake, adopt } = boot(world(), { busy: () => false });
				seedOwners(fake);

				const { reply } = await adopt(SESSION_B, 5);

				expect(reply).toEqual({ ok: true });
				expect(groupOf(fake, 5)).toBe(11);
				expect(fake.record(SESSION_B)?.selectedTabId).toBe(5);
				expect([undefined, 6]).toContain(fake.record(SESSION_A)?.selectedTabId);
			});

			it("keeps the old selection when the moved tab was not the selected one", async () => {
				const { fake, adopt } = boot(world(), { busy: () => false });
				seedOwners(fake);

				await adopt(SESSION_B, 6);

				expect(groupOf(fake, 6)).toBe(11);
				expect(fake.record(SESSION_A)?.selectedTabId).toBe(5);
			});

			it("tolerates the old group vanishing when it loses its last tab", async () => {
				const { fake, adopt } = boot(
					{
						tabs: [plain(5, { groupId: 10 }), plain(8, { groupId: 11 })],
						groups: [
							{ id: 10, windowId: 1, title: "t", color: "blue" },
							{ id: 11, windowId: 1, title: "t", color: "red" },
						],
					},
					{ busy: () => false },
				);
				seedOwners(fake);
				const group = fake.raw.tabs.group.getMockImplementation() as (
					options: { tabIds: number[]; groupId?: number },
				) => Promise<number>;
				fake.raw.tabs.group.mockImplementation(async (options) => {
					const id = await group(options);
					fake.groups.delete(10);
					return id;
				});

				const { reply } = await adopt(SESSION_B, 5);

				expect(reply).toEqual({ ok: true });
				expect(fake.record(SESSION_A)?.selectedTabId).toBeUndefined();
				expect(fake.record(SESSION_B)?.selectedTabId).toBe(5);
			});

			it("defaults to not busy when no busy function is passed", async () => {
				const { fake, adopt } = boot(world());
				seedOwners(fake);

				const { reply } = await adopt(SESSION_B, 5);

				expect(reply).toEqual({ ok: true });
				expect(groupOf(fake, 5)).toBe(11);
			});
		});
	});

	describe("listener", () => {
		it("refuses a message from a tab and moves nothing", async () => {
			const { fake, adopt, list } = boot({ tabs: [tabOf({ id: 5 })] });
			const sender = { id: EXTENSION_ID, tab: { id: 1 } };

			const adopted = await adopt(SESSION_A, 5, "agent", sender);
			const listed = await list(sender);

			expect(adopted.reply).toMatchObject({ ok: false });
			expect(listed.reply).toMatchObject({ ok: false });
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)).toBeUndefined();
		});

		it("refuses a message from another extension and moves nothing", async () => {
			const { fake, adopt, list } = boot({ tabs: [tabOf({ id: 5 })] });
			const sender = { id: "some-other-extension" };

			const adopted = await adopt(SESSION_A, 5, "agent", sender);
			const listed = await list(sender);

			expect(adopted.reply).toMatchObject({ ok: false });
			expect(listed.reply).toMatchObject({ ok: false });
			expect(fake.raw.tabs.group).not.toHaveBeenCalled();
			expect(fake.record(SESSION_A)).toBeUndefined();
		});

		it.each([
			[MSG.connectionRequest],
			[MSG.openChat],
			["not-a-dg-message"],
		])("returns undefined without answering a %s message", async (type) => {
			const { send } = boot();
			const respond = mock(() => undefined);
			const [listener] = [...currentListeners];

			const returned = (listener as Listener)({ type }, { id: EXTENSION_ID }, respond);
			await Bun.sleep(0);
			await send({ type });

			expect(returned).toBeUndefined();
			expect(respond).not.toHaveBeenCalled();
		});

		it("returns undefined for a message with no type", () => {
			boot();
			const [listener] = [...currentListeners];

			expect((listener as Listener)(undefined, { id: EXTENSION_ID }, () => undefined)).toBeUndefined();
			expect((listener as Listener)("text", { id: EXTENSION_ID }, () => undefined)).toBeUndefined();
		});

		it("replies ok false with the error text when the browser call throws", async () => {
			const { fake, adopt } = boot({ tabs: [tabOf({ id: 5 })] });
			fake.raw.tabs.group.mockRejectedValueOnce(new Error("group failed"));

			const { handled, reply } = await adopt(SESSION_A, 5);

			expect(handled).toBe(true);
			expect(reply).toEqual({ ok: false, error: "group failed" });
		});
	});

	describe("tab group removal", () => {
		it("drops the record of a group the user closed", async () => {
			const { fake } = boot();
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10 }));
			fake.seedRecord(recordOf({ sessionId: SESSION_B, groupId: 11 }));

			for (const fn of currentGroupRemoved) fn({ id: 10 });
			await Bun.sleep(1100);

			expect(fake.record(SESSION_A)).toBeUndefined();
			expect(fake.record(SESSION_B)).toBeDefined();
		});

		it("keeps every record when an unrelated group is removed", async () => {
			const { fake } = boot();
			fake.seedRecord(recordOf({ sessionId: SESSION_A, groupId: 10 }));

			for (const fn of currentGroupRemoved) fn({ id: 99 });
			await Bun.sleep(0);

			expect(fake.record(SESSION_A)).toBeDefined();
		});
	});
});

describe("createAgentTabs adopt", () => {
	it("refuses a tab in a busy agent's group and moves nothing", async () => {
		const fake = createFakeBrowser({
			tabs: [tabOf({ id: 5, groupId: 10 })],
			groups: [{ id: 10, windowId: 1, title: "t", color: "blue" }],
		});
		fake.seedRecord(recordOf({ sessionId: SESSION_A, agentIdentity: "owner", groupId: 10 }));
		const agentTabs = createAgentTabs({
			browserApi: fake.api,
			storage: fake.api.storage,
			lock: createLock(),
			busy: ({ sessionId }) => sessionId === SESSION_A,
		});

		await expect(
			agentTabs.adopt({ sessionId: SESSION_B, agentIdentity: "agent", tabId: 5 }),
		).rejects.toThrow();

		expect(groupOf(fake, 5)).toBe(10);
		expect(fake.record(SESSION_B)).toBeUndefined();
	});

	it("reports the tabs of a group an adopt recovered", async () => {
		const { fake, agentTabs, open } = setup({ tabs: [tabOf({ id: 5 })] });
		const first = await open();
		fake.reload();

		const adopted = await agentTabs.adopt({
			sessionId: SESSION_A,
			agentIdentity: "agent",
			tabId: 5,
		});

		expect(adopted.recoveredTabIds).toEqual([first.tabId]);
		expect(fake.groups.size).toBe(1);
	});

	it("adopts a loose tab and makes it the selected tab", async () => {
		const { fake, agentTabs } = setup({ tabs: [tabOf({ id: 5 })] });

		await agentTabs.adopt({ sessionId: SESSION_A, agentIdentity: "agent", tabId: 5 });

		expect(await agentTabs.selected({ sessionId: SESSION_A })).toMatchObject({ tabId: 5 });
		expect(await agentTabs.owns({ sessionId: SESSION_A, tabId: 5 })).toBe(true);
		expect(fake.groups.size).toBe(1);
	});
});

describe("agent tab open cancel", () => {
	it("closes a tab it created after the open was canceled, and saves no record", async () => {
		const fake = createFakeBrowser({ windows: [windowOf({ id: 1 })], lastFocusedWindowId: 1 });
		const agentTabs = createAgentTabs({ browserApi: fake.api, storage: fake.api.storage, lock: createLock() });
		let calls = 0;
		await expect(
			agentTabs.open({ sessionId: "s1", agentIdentity: "agent", url: "https://a.test/", canceled: () => ++calls > 2 }),
		).rejects.toThrow("canceled");
		expect(fake.raw.tabs.remove).toHaveBeenCalled();
		expect(fake.record("s1")).toBeUndefined();
	});
});
