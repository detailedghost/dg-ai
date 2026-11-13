import { afterEach, describe, expect, it } from "bun:test";
import { PW_EXT_MAX_TEXT_CHARS, type PwExtRequest } from "@dg/common";
import { PW_EXT_MAILBOX_ERROR } from "@/lib/background/tab-guards";
import { createAgentTabs, groupTitle } from "@/lib/background/agent-tabs";
import { createPwExtHandler } from "@/lib/background/pw-ext";
import { forgetAgentTabsAndShims } from "@/lib/background/dialog-shim";
import { createSessionControl, type SessionControl } from "@/lib/background/session-control";

const allowAllSites: SessionControl = {
	allowed: async () => true,
	allow: async () => undefined,
	stopped: async () => false,
	stop: async () => undefined,
	forget: async () => undefined,
};
import {
	createFakeBrowser,
	createLock,
	type FakeTab,
	recordOf,
	tabOf,
	windowOf,
} from "./utils/fake-browser";

const SESSION = "session-1";
const OTHER_SESSION = "session-2";
const IDENTITY = "claude-orchestrator";
const WINDOW = 3;
const GROUP = 10;
const OTHER_GROUP = 11;
const GROUP_TAB_LIMIT = 200;

const NOT_IN_GROUP = (id: number) =>
	`pw --ext: tab ${id} is not in this agent's tab group; run pw --ext tabs to list them.`;
const SELECTED_GONE =
	"This agent's selected tab was closed or moved out of its group. Run pw --ext tabs, then pw --ext select <id>.";
const NO_TAB = "This agent has no tab yet. Run pw --ext new <url> first.";
const DISCARDED = (id: number) =>
	`This agent's tab was discarded by the browser. Run pw --ext select ${id} again after it reloads.`;
const FULL =
	"This agent's tab group is full (200 tabs). Close some with pw --ext close <id>.";
const NO_SESSION = "pw --ext needs a paired session.";

const WEB_TAB: FakeTab = tabOf({
	id: 7,
	windowId: WINDOW,
	groupId: GROUP,
	url: "https://app.example.test/home?token=zzzzzzzzzzzzzzzz",
	title: "Home",
	active: true,
});

const groupTab = (id: number, overrides: Partial<FakeTab> = {}) =>
	tabOf({ id, windowId: WINDOW, groupId: GROUP, ...overrides });

type Options = {
	tabs?: FakeTab[];
	selected?: number | null;
	record?: boolean;
	pageResult?: unknown;
	mainResult?: (action: unknown) => unknown;
	asset?: Blob;
	chromium?: boolean;
	signal?: AbortSignal;
	windowState?: "normal" | "minimized" | "maximized";
	approval?: "allow" | "deny" | "closed" | "timeout" | "unopened";
	clock?: { now: number };
	onApproval?: () => void | Promise<void>;
	enabledBuiltIns?: () => Promise<Set<string>>;
	pageDeadlineMs?: number;
	sites?: "ask";
};

type Executed = {
	args: unknown[];
	world?: string;
	target: { tabId: number };
};

function harness(options: Options = {}) {
	const tabs = options.tabs ?? [WEB_TAB];
	const fetched: string[] = [];
	const deleted: string[] = [];
	const fake = createFakeBrowser({
		windows: [windowOf({ id: WINDOW, state: options.windowState ?? "normal" })],
		lastFocusedWindowId: WINDOW,
		tabs: [
			...tabs,
			tabOf({ id: 20, windowId: WINDOW, groupId: OTHER_GROUP, title: "Other agent" }),
			tabOf({ id: 21, windowId: WINDOW, title: "User tab" }),
		],
		groups: [
			{ id: GROUP, windowId: WINDOW, title: "mine" },
			{ id: OTHER_GROUP, windowId: WINDOW, title: "theirs" },
		],
	});
	if (options.record !== false)
		fake.seedRecord(
			recordOf({
				sessionId: SESSION,
				agentIdentity: IDENTITY,
				groupId: GROUP,
				...(options.selected === null
					? {}
					: { selectedTabId: options.selected ?? 7 }),
			}),
		);
	fake.seedRecord(
		recordOf({ sessionId: OTHER_SESSION, groupId: OTHER_GROUP, selectedTabId: 20 }),
	);
	fake.state.script = (details) => {
		const call = details as { args: unknown[]; world?: string };
		if (call.world === "MAIN") return options.mainResult?.(call.args[0]);
		return options.pageResult;
	};
	const agentTabsLock = createLock();
	const agentTabs = createAgentTabs({
		browserApi: fake.api,
		storage: fake.api.storage,
		lock: agentTabsLock,
	});
	const approvalRequests: unknown[] = [];
	const clock = options.clock ?? { now: Date.UTC(2026, 10, 9, 15, 0) };
	const handler = createPwExtHandler({
		browserApi: fake.api,
		agentTabs,
		isChromium: () => options.chromium ?? true,
		approvals: {
			request: async (request) => {
				approvalRequests.push(request);
				await options.onApproval?.();
				return options.approval ?? "deny";
			},
		},
		now: () => clock.now,
		...(options.enabledBuiltIns ? { enabledBuiltIns: options.enabledBuiltIns } : {}),
		...(options.pageDeadlineMs ? { pageDeadlineMs: options.pageDeadlineMs } : {}),
		lock: agentTabsLock,
		control: options.sites === "ask" ? createSessionControl({ storage: fake.api.storage }) : allowAllSites,
	});
	const call = (
		request: PwExtRequest,
		context: unknown = {
			sessionId: SESSION,
			agentIdentity: IDENTITY,
			deleteAsset: async (assetId: string) => {
				deleted.push(assetId);
			},
			fetchAsset: async (assetId: string) => {
				fetched.push(assetId);
				if (!options.asset) throw new Error("no asset");
				return options.asset;
			},
		},
	) =>
		handler({
			request,
			timeoutMs: 60_000,
			signal: options.signal ?? new AbortController().signal,
			progress: () => undefined,
			context,
		} as never);
	return {
		handler,
		approvalRequests,
		agentTabsLock,
		clock,
		run: (request: PwExtRequest) => call(request),
		runAs: (sessionId: string, request: PwExtRequest) =>
			call(request, { sessionId, agentIdentity: IDENTITY, deleteAsset: async () => undefined, fetchAsset: async () => new Blob() }),
		runWith:
			(context: { fetchAsset(id: string): Promise<Blob> }) =>
			(request: PwExtRequest) =>
				call(request, {
					sessionId: SESSION,
					agentIdentity: IDENTITY,
					deleteAsset: async () => undefined,
					...context,
				}),
		runWithoutContext: (request: PwExtRequest) => call(request, null),
		fake,
		agentTabs,
		fetched,
		deleted,
		executed: () =>
			fake.raw.scripting.executeScript.mock.calls.map(
				([details]) => details as Executed,
			),
		created: () => fake.raw.tabs.create.mock.calls.map(([props]) => props),
		createdTab: async (index = 0) =>
			(await fake.raw.tabs.create.mock.results[index]?.value) as FakeTab,
		selectedId: () => fake.record(SESSION)?.selectedTabId,
	};
}

function outcome(answer: {
	ok: boolean;
	data?: { text: string };
	error?: string;
}) {
	return answer.ok ? (answer.data?.text ?? "") : (answer.error ?? "");
}

describe("pw --ext background handler", () => {
	it("discards a screenshot when the window switched tabs during capture", async () => {
		const h = harness();
		h.fake.state.duringCapture = () => {
			const tab = h.fake.tabs.get(7);
			if (tab) tab.active = false;
		};

		expect(await h.run({ verb: "screenshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("changed"),
		});
	});

	it("discards a screenshot when the window switched away and back during capture", async () => {
		const h = harness();
		h.fake.state.duringCapture = () => {
			h.fake.fireActivated({ tabId: 8, windowId: WINDOW });
			h.fake.fireActivated({ tabId: 7, windowId: WINDOW });
		};

		expect(await h.run({ verb: "screenshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("changed"),
		});
	});

	it("runs a click with no approval step and binds it to the page URL", async () => {
		const h = harness({ pageResult: { detail: "clicked" } });

		expect(await h.run({ verb: "click", target: "e1" })).toMatchObject({ ok: true });
		expect(h.executed()[0]?.args).toEqual([
			{ kind: "click", target: "e1" },
			WEB_TAB.url,
			false,
			[],
			expect.any(Number),
		]);
		expect(h.executed()[0]?.target.tabId).toBe(7);
	});

	it("runs a count in the page and prints its match list", async () => {
		const h = harness({ pageResult: { detail: "#q matches 1 element\n1. <input id=\"q\">" } });
		const answer = await h.run({ verb: "count", target: "#q" });

		expect(answer).toMatchObject({ ok: true });
		if (answer.ok) expect(answer.data.text).toContain("#q matches 1 element");
		expect(h.executed()[0]?.args).toEqual([{ kind: "count", target: "#q" }, WEB_TAB.url, false, [], expect.any(Number)]);
	});

	it("runs a fill and keeps the typed value out of the result", async () => {
		const h = harness({ pageResult: { detail: 'filled textbox "Search"' } });
		const answer = await h.run({ verb: "fill", target: "e2", value: "cats" });

		expect(answer).toMatchObject({ ok: true });
		if (answer.ok) expect(answer.data.text).not.toContain("cats");
		expect(h.executed()[0]?.args[0]).toEqual({
			kind: "fill",
			target: "e2",
			value: "cats",
		});
	});

	it("does nothing when the request is already canceled", async () => {
		const cancel = new AbortController();
		cancel.abort();
		const h = harness({ signal: cancel.signal });

		expect(await h.run({ verb: "click", target: "e1" })).toEqual({
			ok: false,
			error: expect.stringContaining("canceled"),
		});
		expect(h.executed()).toEqual([]);
	});

	it("does not navigate when the request is canceled while the tab is read", async () => {
		const cancel = new AbortController();
		const h = harness({ signal: cancel.signal });
		h.fake.raw.tabs.get.mockImplementationOnce(async () => {
			cancel.abort();
			return WEB_TAB;
		});

		expect(await h.run({ verb: "open", url: "https://example.test/" })).toEqual({
			ok: false,
			error: expect.stringContaining("canceled"),
		});
		expect(h.fake.tabs.get(7)?.url).toBe(WEB_TAB.url);
		expect(h.fake.raw.tabs.update).not.toHaveBeenCalled();
	});

	it("rejects a malformed or oversized page result", async () => {
		for (const pageResult of [
			{ tree: "x".repeat(200_000), text: "" },
			{ detail: 5 },
			{ surprise: true },
		]) {
			const h = harness({ pageResult });

			expect(await h.run({ verb: "snapshot" })).toMatchObject({ ok: false });
		}
	});

	it("returns a redacted snapshot", async () => {
		const h = harness({
			pageResult: {
				tree: '- button "Go" [ref=e1]\n- text: ghp_abcdefghijklmnopqrstuvwxyz',
				text: "Contact me@example.test",
			},
		});
		const answer = await h.run({ verb: "snapshot" });

		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.data.text).toContain("### Page");
		expect(answer.data.text).toContain('- button "Go" [ref=e1]');
		expect(answer.data.text).toContain("### Visible text");
		expect(answer.data.text).not.toContain("zzzzzzzzzzzzzzzz");
		expect(answer.data.text).not.toContain("ghp_abcdefghij");
		expect(answer.data.text).not.toContain("me@example.test");
	});

	it.each([
		"chrome://settings/passwords",
		"edge://settings",
		"brave://wallet",
		"about:blank",
		"chrome-extension://abcdefghijklmnop/options.html",
		"file:///home/me/notes.txt",
		"https://chromewebstore.google.com/detail/x",
	])("blocks %s", async (url) => {
		const h = harness({ tabs: [{ ...WEB_TAB, url }] });

		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("browser settings"),
		});
		expect(h.executed()).toEqual([]);
	});

	it.each([
		{ verb: "snapshot" },
		{ verb: "click", target: "e1" },
		{ verb: "fill", target: "e1", value: "x" },
		{ verb: "selection" },
		{ verb: "console" },
		{ verb: "tools" },
		{ verb: "current" },
		{ verb: "screenshot" },
	] as PwExtRequest[])("blocks a browser page for %p without running a script", async (request) => {
		const h = harness({ tabs: [{ ...WEB_TAB, url: "chrome://settings" }] });

		expect(await h.run(request)).toEqual({
			ok: false,
			error: expect.stringContaining("browser settings"),
		});
		expect(h.executed()).toEqual([]);
	});

	it.each([
		{ verb: "snapshot" },
		{ verb: "click", target: "e1" },
		{ verb: "fill", target: "e1", value: "x" },
		{ verb: "screenshot" },
		{ verb: "close" },
		{ verb: "open", url: "https://example.test/" },
	] as PwExtRequest[])("blocks %p on the signed-in Proton Mail tab", async (request) => {
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox" }],
		});

		expect(await h.run(request)).toEqual({
			ok: false,
			error: expect.stringContaining("Proton Mail"),
		});
		expect(h.executed()).toEqual([]);
		expect(h.fake.tabs.has(7)).toBe(true);
		expect(h.fake.tabs.get(7)?.url).toBe("https://mail.proton.me/u/0/inbox");
	});

	it("hides the title and URL of the Proton Mail tab in listings", async () => {
		const h = harness({
			tabs: [
				{
					...WEB_TAB,
					url: "https://mail.proton.me/u/0/inbox",
					title: "Secret subject",
				},
			],
		});
		const listing = await h.run({ verb: "tabs" });

		expect(listing.ok).toBe(true);
		const text = outcome(listing);
		expect(text).toContain("(protected mailbox)");
		expect(text).not.toContain("Secret subject");
		expect(text).not.toContain("mail.proton.me");
	});

	it("never acts on a private tab or lists it", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, incognito: true }] });

		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("private"),
		});
		expect(h.executed()).toEqual([]);

		const mixed = harness({
			tabs: [WEB_TAB, groupTab(9, { incognito: true, title: "Private" })],
		});
		const listing = await mixed.run({ verb: "tabs" });

		expect(listing.ok).toBe(true);
		expect(outcome(listing)).not.toContain("Private");
		expect(outcome(listing)).toContain("7:");
	});

	it("refuses to navigate a private selected tab", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, incognito: true }] });

		expect(await h.run({ verb: "open", url: "https://example.test/" })).toEqual({
			ok: false,
			error: expect.stringContaining("private"),
		});
		expect(h.fake.raw.tabs.update).not.toHaveBeenCalled();
	});

	it("refuses a non-Chromium browser", async () => {
		const h = harness({ chromium: false });

		expect(await h.run({ verb: "current" })).toEqual({
			ok: false,
			error: expect.stringContaining("Chromium"),
		});
	});

	it("reports the selected tab URL and title and no tab list for current", async () => {
		const h = harness({
			tabs: [WEB_TAB, groupTab(8, { title: "Second" })],
		});
		const answer = await h.run({ verb: "current" });

		expect(answer.ok).toBe(true);
		const text = outcome(answer);
		expect(text).toContain("### Page");
		expect(text).toContain("- Page URL: https://app.example.test/home?token=[redacted]");
		expect(text).toContain("- Page Title: Home");
		expect(text).not.toContain("### Tabs");
		expect(text).not.toContain("Second");
	});

	it("lists only the group's tabs with the selected one marked", async () => {
		const h = harness({
			tabs: [
				WEB_TAB,
				groupTab(8, { url: "chrome://settings", title: "Settings" }),
			],
		});
		const answer = await h.run({ verb: "tabs" });

		expect(answer.ok).toBe(true);
		const text = outcome(answer);
		expect(text).toContain("### Tabs");
		expect(text).toContain(
			"- [selected] 7: Home — https://app.example.test/home?token=[redacted]",
		);
		expect(text).toContain("- 8: (browser page)");
		expect(text).not.toContain("chrome://settings");
		expect(text).not.toContain("Other agent");
		expect(text).not.toContain("User tab");
		expect(text).not.toMatch(/\b2[01]:/);
	});

	it("cuts a long tab list and counts the rest", async () => {
		const extra = GROUP_TAB_LIMIT + 5 - 1;
		const h = harness({
			tabs: [
				WEB_TAB,
				...Array.from({ length: extra }, (_, i) => groupTab(2000 + i)),
			],
		});
		const text = outcome(await h.run({ verb: "tabs" }));
		const rows = text
			.split("\n")
			.filter((line) => /^- (\[selected\] )?\d+:/.test(line));

		expect(rows).toHaveLength(GROUP_TAB_LIMIT);
		expect(text).toContain("- … 5 more");
	});

	it("opens a grouped inactive tab and selects it when the agent has none", async () => {
		const h = harness({ record: false, tabs: [] });
		const answer = await h.run({ verb: "open", url: "https://example.test/" });
		const tab = await h.createdTab();

		expect(answer).toMatchObject({ ok: true });
		expect(outcome(answer)).toContain(`Opened https://example.test/ in tab ${tab.id}`);
		expect(h.created()).toHaveLength(1);
		const stored = h.fake.tabs.get(tab.id);
		expect(stored?.active).toBe(false);
		expect(stored?.groupId).not.toBe(-1);
		expect(h.fake.groups.get(stored?.groupId as number)?.title).toBe(
			groupTitle({ agentIdentity: IDENTITY, sessionId: SESSION }),
		);
		expect(h.selectedId()).toBe(tab.id);
	});

	it("navigates the same tab on a second open", async () => {
		const h = harness({ record: false, tabs: [] });
		await h.run({ verb: "open", url: "https://example.test/" });
		const tab = await h.createdTab();
		const answer = await h.run({ verb: "open", url: "https://second.example.test/" });

		expect(answer).toMatchObject({ ok: true });
		expect(h.created()).toHaveLength(1);
		expect(h.fake.raw.tabs.update).toHaveBeenCalledWith(tab.id, {
			url: "https://second.example.test/",
		});
		expect(h.selectedId()).toBe(tab.id);
	});

	it("navigates the selected tab on open", async () => {
		const h = harness();
		const answer = await h.run({ verb: "open", url: "https://example.test/" });

		expect(answer).toMatchObject({ ok: true });
		expect(h.created()).toEqual([]);
		expect(h.fake.raw.tabs.update).toHaveBeenCalledWith(7, {
			url: "https://example.test/",
		});
	});

	it("returns a screenshot of the selected tab", async () => {
		const h = harness();

		expect(await h.run({ verb: "screenshot" })).toMatchObject({
			ok: true,
			data: { image: "data:image/jpeg;base64,AAAA" },
		});
	});

	it("reports a page error without data", async () => {
		const h = harness({ pageResult: { error: "No element matches .x." } });

		expect(await h.run({ verb: "click", target: ".x" })).toEqual({
			ok: false,
			error: "No element matches .x.",
		});
	});

	it("rejects a request that fails validation", async () => {
		const h = harness();

		expect(
			await h.run({ verb: "eval" } as unknown as PwExtRequest),
		).toMatchObject({ ok: false });
	});

	it("refuses a request that carries no paired session", async () => {
		const h = harness();

		expect(await h.runWithoutContext({ verb: "snapshot" })).toEqual({
			ok: false,
			error: NO_SESSION,
		});
		expect(h.executed()).toEqual([]);
	});
});

describe("pw --ext agent tab ownership", () => {
	it.each([
		["another agent's group", 20],
		["no group", 21],
		["a tab that does not exist", 424242],
	])("refuses --tab for a tab in %s and runs no script", async (_name, tabId) => {
		const h = harness({ pageResult: { detail: "clicked" } });

		expect(await h.run({ verb: "click", target: "e4", tabId })).toEqual({
			ok: false,
			error: NOT_IN_GROUP(tabId),
		});
		expect(h.executed()).toEqual([]);
	});

	it("targets an owned tab once and leaves the selection alone", async () => {
		const h = harness({
			tabs: [WEB_TAB, groupTab(8, { url: "https://second.example.test/" })],
			pageResult: { tree: "- button", text: "t" },
		});
		const answer = await h.run({ verb: "snapshot", tabId: 8 });

		expect(answer).toMatchObject({ ok: true });
		const pageCall = h.executed().find((call) => (call as { func?: { name?: string } }).func?.name === "pwExtPageAction");
		expect(pageCall?.target.tabId).toBe(8);
		expect(pageCall?.args[1]).toBe("https://second.example.test/");
		expect(h.selectedId()).toBe(7);
	});

	it("tells the agent to reselect when its selected tab moved into another group", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, groupId: OTHER_GROUP }, groupTab(8)],
		});

		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: SELECTED_GONE,
		});
		expect(h.executed()).toEqual([]);
		expect(h.fake.tabs.get(8)?.active).toBe(false);
	});

	it("tells the agent to reselect when its selected tab was closed", async () => {
		const h = harness({ tabs: [WEB_TAB, groupTab(8)] });
		h.fake.removeTab(7);

		expect(await h.run({ verb: "click", target: "e1" })).toEqual({
			ok: false,
			error: SELECTED_GONE,
		});
		expect(h.executed()).toEqual([]);
	});

	it("says the agent has no tab when it has no record", async () => {
		const h = harness({ record: false, tabs: [] });

		expect(await h.run({ verb: "snapshot" })).toEqual({ ok: false, error: NO_TAB });
		expect(h.executed()).toEqual([]);
	});

	it("says the agent has no tab when its group is empty", async () => {
		const h = harness({ tabs: [], selected: null });

		expect(await h.run({ verb: "snapshot" })).toEqual({ ok: false, error: NO_TAB });
	});

	it("never lists a tab outside the group", async () => {
		const h = harness();
		const text = outcome(await h.run({ verb: "tabs" }));

		expect(text).not.toContain("Other agent");
		expect(text).not.toContain("User tab");
	});

	it("refuses every page verb on a discarded tab", async () => {
		for (const request of [
			{ verb: "snapshot" },
			{ verb: "click", target: "e1" },
			{ verb: "selection" },
			{ verb: "screenshot" },
		] as PwExtRequest[]) {
			const h = harness({ tabs: [{ ...WEB_TAB, discarded: true }] });

			expect(await h.run(request)).toEqual({ ok: false, error: DISCARDED(7) });
			expect(h.executed()).toEqual([]);
		}
	});
});

describe("pw --ext new, select and close", () => {
	it("creates an inactive tab in the group and selects it", async () => {
		const h = harness();
		const answer = await h.run({ verb: "new", url: "https://fresh.example.test/" });
		const tab = await h.createdTab();

		expect(answer).toMatchObject({ ok: true });
		expect(h.fake.tabs.get(tab.id)).toMatchObject({
			url: "https://fresh.example.test/",
			groupId: GROUP,
			active: false,
		});
		expect(h.selectedId()).toBe(tab.id);
	});

	it("opens chrome://newtab/ when new has no URL", async () => {
		const h = harness();
		await h.run({ verb: "new" });

		expect(h.created()).toEqual([
			expect.objectContaining({ url: "chrome://newtab/", active: false }),
		]);
	});

	it("allows new, tabs and close while the selected tab is a browser page", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "chrome://settings" }, groupTab(8)],
		});

		expect(await h.run({ verb: "tabs" })).toMatchObject({ ok: true });
		expect(
			await h.run({ verb: "new", url: "https://fresh.example.test/" }),
		).toMatchObject({ ok: true });
		expect(await h.run({ verb: "close", tabId: 8 })).toMatchObject({ ok: true });
	});

	it("allows open to navigate a selected browser page", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, url: "chrome://settings" }] });

		expect(
			await h.run({ verb: "open", url: "https://example.test/" }),
		).toMatchObject({ ok: true });
		expect(h.fake.tabs.get(7)?.url).toBe("https://example.test/");
	});

	it("lets open navigate the tab that new created", async () => {
		const h = harness({ record: false, tabs: [] });
		await h.run({ verb: "new" });
		const tab = await h.createdTab();
		const answer = await h.run({ verb: "open", url: "https://example.test/" });

		expect(answer).toMatchObject({ ok: true });
		expect(h.created()).toHaveLength(1);
		expect(h.fake.raw.tabs.update).toHaveBeenCalledWith(tab.id, {
			url: "https://example.test/",
		});
	});

	it("refuses new beyond the group limit", async () => {
		const h = harness({
			tabs: [
				WEB_TAB,
				...Array.from({ length: GROUP_TAB_LIMIT - 1 }, (_, i) =>
					groupTab(2000 + i),
				),
			],
		});

		expect(
			await h.run({ verb: "new", url: "https://fresh.example.test/" }),
		).toEqual({ ok: false, error: FULL });
		expect(h.created()).toEqual([]);
	});

	it("refuses open and creates no tab when the selected tab was closed", async () => {
		const h = harness({ tabs: [WEB_TAB, groupTab(8)] });
		h.fake.removeTab(7);

		expect(await h.run({ verb: "open", url: "https://a.example.test/" })).toEqual({
			ok: false,
			error: SELECTED_GONE,
		});
		expect(h.created()).toEqual([]);
		expect(h.fake.raw.tabs.update).not.toHaveBeenCalled();
	});

	it("refuses open and creates no tab when the selected tab moved out of the group", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, groupId: OTHER_GROUP }, groupTab(8)],
		});

		expect(await h.run({ verb: "open", url: "https://a.example.test/" })).toEqual({
			ok: false,
			error: SELECTED_GONE,
		});
		expect(h.created()).toEqual([]);
		expect(h.fake.tabs.get(7)?.url).toBe(WEB_TAB.url);
	});

	it("lets exactly one of two concurrent new calls take the last slot", async () => {
		const h = harness({
			tabs: [
				WEB_TAB,
				...Array.from({ length: GROUP_TAB_LIMIT - 2 }, (_, i) =>
					groupTab(2000 + i),
				),
			],
		});

		const answers = await Promise.all([
			h.run({ verb: "new", url: "https://one.example.test/" }),
			h.run({ verb: "new", url: "https://two.example.test/" }),
		]);

		expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
		expect(answers.filter((answer) => !answer.ok)).toEqual([
			{ ok: false, error: FULL },
		]);
		expect(h.created()).toHaveLength(1);
		expect(h.fake.tabsInGroup(GROUP)).toHaveLength(GROUP_TAB_LIMIT);
	});

	it("selects an owned tab without activating it", async () => {
		const h = harness({ tabs: [WEB_TAB, groupTab(8)] });
		const answer = await h.run({ verb: "select", tabId: 8 });

		expect(answer).toMatchObject({ ok: true });
		expect(h.selectedId()).toBe(8);
		expect(h.fake.tabs.get(8)?.active).toBe(false);
	});

	it.each([
		["another agent's group", 20],
		["no group", 21],
	])("refuses to select a tab in %s", async (_name, tabId) => {
		const h = harness();

		expect(await h.run({ verb: "select", tabId })).toEqual({
			ok: false,
			error: NOT_IN_GROUP(tabId),
		});
		expect(h.selectedId()).toBe(7);
	});

	it("refuses to select a browser page", async () => {
		const h = harness({
			tabs: [WEB_TAB, groupTab(8, { url: "chrome://settings" })],
		});

		expect(await h.run({ verb: "select", tabId: 8 })).toEqual({
			ok: false,
			error: expect.stringContaining("browser settings"),
		});
		expect(h.selectedId()).toBe(7);
	});

	it("closes the selected tab, moves the selection to the last tab and reports it", async () => {
		const h = harness({ tabs: [WEB_TAB, groupTab(8), groupTab(9)] });
		const answer = await h.run({ verb: "close" });

		expect(answer.ok).toBe(true);
		expect(outcome(answer)).toContain("Closed tab 7");
		expect(outcome(answer)).toContain("Selected tab 9");
		expect(h.fake.tabs.has(7)).toBe(false);
		expect(h.selectedId()).toBe(9);
	});

	it("closes a named tab without moving the selection", async () => {
		const h = harness({ tabs: [WEB_TAB, groupTab(8)] });
		const answer = await h.run({ verb: "close", tabId: 8 });

		expect(outcome(answer)).toContain("Closed tab 8");
		expect(outcome(answer)).not.toContain("Selected tab");
		expect(h.selectedId()).toBe(7);
	});

	it("clears the selection when the last tab closes", async () => {
		const h = harness();
		const answer = await h.run({ verb: "close" });

		expect(outcome(answer)).toContain("Closed tab 7");
		expect(outcome(answer)).not.toContain("Selected tab");
		expect(h.selectedId()).toBeUndefined();
		expect(await h.run({ verb: "snapshot" })).toEqual({ ok: false, error: NO_TAB });
	});

	it.each([
		["another agent's group", 20],
		["no group", 21],
	])("refuses to close a tab in %s", async (_name, tabId) => {
		const h = harness();

		expect(await h.run({ verb: "close", tabId })).toEqual({
			ok: false,
			error: NOT_IN_GROUP(tabId),
		});
		expect(h.fake.tabs.has(tabId)).toBe(true);
	});
});

describe("pw --ext screenshot", () => {
	const originalFrame = (globalThis as { requestAnimationFrame?: unknown })
		.requestAnimationFrame;

	afterEach(() => {
		(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
			originalFrame;
	});

	it("brings a background tab to the front, waits one frame, captures and leaves it in front", async () => {
		let frames = 0;
		(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
			callback: (time: number) => void,
		) => {
			frames += 1;
			callback(0);
			return frames;
		};
		const h = harness({
			windowState: "minimized",
			tabs: [{ ...WEB_TAB, active: false }, groupTab(8, { active: true })],
		});
		h.fake.state.script = (details) => {
			const call = details as {
				func: (...args: unknown[]) => unknown;
				args: unknown[];
			};
			return call.func(...call.args);
		};
		const answer = await h.run({ verb: "screenshot" });
		const first = (mock: { mock: { invocationCallOrder: number[] } }) =>
			mock.mock.invocationCallOrder[0] as number;

		expect(answer).toMatchObject({
			ok: true,
			data: { image: "data:image/jpeg;base64,AAAA" },
		});
		expect(h.fake.raw.tabs.update).toHaveBeenCalledWith(7, { active: true });
		expect(h.fake.raw.windows.update).toHaveBeenCalledWith(WINDOW, {
			focused: true,
			state: "normal",
		});
		expect(h.fake.windows.get(WINDOW)?.state).toBe("normal");
		expect(frames).toBe(1);
		expect(h.executed()).toHaveLength(1);
		expect(h.executed()[0]?.target.tabId).toBe(7);
		expect(first(h.fake.raw.tabs.update)).toBeLessThan(
			first(h.fake.raw.scripting.executeScript),
		);
		expect(first(h.fake.raw.scripting.executeScript)).toBeLessThan(
			first(h.fake.raw.tabs.captureVisibleTab),
		);
		expect(h.fake.tabs.get(7)?.active).toBe(true);
		expect(h.fake.tabs.get(8)?.active).toBe(false);
		expect(h.fake.raw.tabs.update).toHaveBeenCalledTimes(1);
	});

	it("focuses a maximized window without changing its state", async () => {
		const h = harness({
			windowState: "maximized",
			tabs: [{ ...WEB_TAB, active: false }],
		});
		const answer = await h.run({ verb: "screenshot" });

		expect(answer).toMatchObject({ ok: true });
		expect(h.fake.raw.windows.update).toHaveBeenCalledTimes(1);
		expect(h.fake.raw.windows.update).toHaveBeenCalledWith(WINDOW, {
			focused: true,
		});
		expect(h.fake.windows.get(WINDOW)?.state).toBe("maximized");
	});

	it("does not discard the capture for the activation's own event", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, active: false }] });
		const answer = await h.run({ verb: "screenshot" });

		expect(answer).toMatchObject({ ok: true });
	});

	it("still discards the capture when the user switches tabs after it began", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, active: false }, groupTab(8)],
		});
		h.fake.state.duringCapture = () =>
			h.fake.fireActivated({ tabId: 8, windowId: WINDOW });

		expect(await h.run({ verb: "screenshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("changed"),
		});
	});

	it("captures the tab chosen with --tab without changing the selection", async () => {
		const h = harness({
			tabs: [WEB_TAB, groupTab(8, { active: false })],
		});
		const answer = await h.run({ verb: "screenshot", tabId: 8 });

		expect(answer).toMatchObject({ ok: true });
		expect(h.fake.raw.tabs.update).toHaveBeenCalledWith(8, { active: true });
		expect(h.selectedId()).toBe(7);
	});
});

describe("pw --ext round 3", () => {
	const UPLOAD: PwExtRequest = {
		verb: "upload",
		target: "#file",
		assetId: "123e4567-e89b-42d3-a456-426614174000",
		fileName: "demo.webm",
		fileSize: 5,
		fileType: "video/webm",
		filePath: "~/work/demo.webm",
	};

	it("uploads a staged asset and deletes it after the fetch", async () => {
		const h = harness({
			pageResult: { detail: 'uploaded demo.webm to button "Attach"' },
			asset: new Blob(["hello"], { type: "video/webm" }),
		});
		const answer = await h.run(UPLOAD);

		expect(h.fetched).toEqual([UPLOAD.assetId as string]);
		expect(h.deleted).toEqual([UPLOAD.assetId as string]);
		expect(h.executed()[0]?.args).toEqual([
			{
				kind: "upload",
				target: "#file",
				base64: Buffer.from("hello").toString("base64"),
				fileName: "demo.webm",
				fileType: "video/webm",
			},
			WEB_TAB.url,
			false,
			[],
			expect.any(Number),
		]);
		expect(answer).toMatchObject({ ok: true });
	});

	it("refuses an upload whose staged bytes do not match the declared size", async () => {
		const h = harness({ asset: new Blob(["longer than five"]) });

		expect(await h.run(UPLOAD)).toEqual({
			ok: false,
			error: expect.stringContaining("size"),
		});
		expect(h.executed()).toEqual([]);
	});

	it("refuses an upload to a plain http page", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, url: "http://app.example.test/" }] });

		expect(await h.run(UPLOAD)).toEqual({
			ok: false,
			error: expect.stringContaining("https"),
		});
	});

	it("lists WebMCP tools, or says there are none", async () => {
		const none = harness({ mainResult: () => ({ api: "none", tools: [] }) });
		const empty = await none.run({ verb: "tools" });

		expect(empty.ok && empty.data.text).toContain("This page exposes no WebMCP tools.");
		const some = harness({
			mainResult: () => ({
				api: "modelContext",
				tools: [
					{
						name: "search",
						description: "Search issues with token=zzzzzzzzzzzz",
						inputSchema: '{"type":"object"}',
					},
				],
			}),
		});
		const listed = await some.run({ verb: "tools" });

		expect(listed.ok && listed.data.text).toContain("- search: Search issues");
		expect(listed.ok && listed.data.text).toContain('input: {"type":"object"}');
		expect(listed.ok && listed.data.text).not.toContain("zzzzzzzzzzzz");
	});

	it("calls a WebMCP tool with its exact args", async () => {
		const actions: unknown[] = [];
		const h = harness({
			mainResult: (action) => {
				actions.push(action);
				return { api: "modelContext", output: "3 results" };
			},
		});
		const answer = await h.run({ verb: "call", tool: "search", args: { q: "bug" } });

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ kind: "call", tool: "search", args: { q: "bug" } });
		expect(answer.ok && answer.data.text).toContain("3 results");
	});

	it("refuses to call a tool the page does not expose", async () => {
		const h = harness({
			mainResult: () => ({ error: "No WebMCP tool named search on this page." }),
		});

		expect(await h.run({ verb: "call", tool: "search", args: {} })).toEqual({
			ok: false,
			error: expect.stringContaining("No WebMCP tool"),
		});
	});

	it("merges isolated errors with MAIN-world console warnings", async () => {
		const h = harness({
			pageResult: { started: false, entries: ["[error] Boom"] },
			mainResult: () => ({ entries: ["[warning] careful"] }),
		});
		const answer = await h.run({ verb: "console" });

		expect(answer.ok && answer.data.text).toContain("[error] Boom");
		expect(answer.ok && answer.data.text).toContain("[warning] careful");
	});
});

describe("pw --ext round 3 review fixes", () => {
	it("does not upload when the request is canceled while the file is fetched", async () => {
		const cancel = new AbortController();
		const h = harness({
			pageResult: { detail: "uploaded" },
			asset: new Blob(["hello"]),
			signal: cancel.signal,
		});
		const run = h.runWith({
			fetchAsset: async () => {
				cancel.abort();
				return new Blob(["hello"]);
			},
		});

		expect(
			await run({
				verb: "upload",
				target: "#file",
				assetId: "123e4567-e89b-42d3-a456-426614174000",
				fileName: "a.txt",
				fileSize: 5,
				fileType: "text/plain",
				filePath: "a.txt",
			}),
		).toEqual({ ok: false, error: expect.stringContaining("canceled") });
		expect(h.executed()).toEqual([]);
	});

	it("passes the tab URL to the console hook and caps its entries", async () => {
		const h = harness({
			pageResult: { started: false, entries: [] },
			mainResult: () => ({
				entries: Array.from({ length: 80 }, () => `[warning] ${"w".repeat(2000)}`),
			}),
		});
		const answer = await h.run({ verb: "console" });
		const main = h.executed().find((call) => call.world === "MAIN");

		expect(main?.args).toEqual([WEB_TAB.url]);
		expect(answer.ok).toBe(true);
		if (answer.ok) {
			const lines = answer.data.text
				.split("\n")
				.filter((line) => line.startsWith("[warning]"));
			expect(lines).toHaveLength(50);
			expect(lines.every((line) => line.length <= 520)).toBe(true);
		}
	});
});

describe("pw --ext unmask", () => {
	const SNAPSHOT = { tree: 'textbox "Email" [ref=e1]: ada@clinic.test', text: "ada@clinic.test token=abc123def456" };
	const ORIGIN = "https://app.example.test";

	it("asks in the browser, names the site and agent, and grants for the minutes asked", async () => {
		const h = harness({ approval: "allow" });
		const answer = await h.run({ verb: "unmask", minutes: 15 });
		expect(answer).toEqual({ ok: true, data: { text: expect.stringContaining(`Unmasked on ${ORIGIN} until`) } });
		expect(h.approvalRequests).toEqual([
			expect.objectContaining({
				origin: ORIGIN,
				lines: expect.arrayContaining([
					`Agent: ${IDENTITY}`,
					`Tab group: ${groupTitle({ agentIdentity: IDENTITY, sessionId: SESSION })}`,
				]),
			}),
		]);
	});

	it("shows email addresses during a grant, keeps tokens masked, and marks the output", async () => {
		const h = harness({ approval: "allow", pageResult: SNAPSHOT });
		const before = await h.run({ verb: "snapshot" });
		expect(JSON.stringify(before)).not.toContain("ada@clinic.test");
		await h.run({ verb: "unmask", minutes: 5 });
		const after = await h.run({ verb: "snapshot" });
		const text = after.ok ? after.data.text : "";
		expect(text).toContain("ada@clinic.test");
		expect(text).toContain(`unmasked on ${ORIGIN} until`);
		expect(text).not.toContain("abc123def456");
		expect(h.executed().at(-1)?.args[2]).toBe(true);
	});

	it.each([
		["deny", "clicked Deny"],
		["closed", "closed without an answer"],
		["timeout", "60 seconds"],
		["unopened", "could not open"],
	] as const)("a %s answer grants nothing", async (approval, message) => {
		const h = harness({ approval, pageResult: SNAPSHOT });
		expect(await h.run({ verb: "unmask", minutes: 15 })).toEqual({ ok: false, error: expect.stringContaining(message) });
		const after = await h.run({ verb: "snapshot" });
		expect(JSON.stringify(after)).not.toContain("ada@clinic.test");
	});

	it("ends at its time and on --off", async () => {
		const h = harness({ approval: "allow", pageResult: SNAPSHOT });
		await h.run({ verb: "unmask", minutes: 1 });
		h.clock.now += 61_000;
		expect(JSON.stringify(await h.run({ verb: "snapshot" }))).not.toContain("ada@clinic.test");
		await h.run({ verb: "unmask", minutes: 10 });
		expect(await h.run({ verb: "unmask", off: true })).toEqual({
			ok: true,
			data: { text: expect.stringContaining(`Ended the unmask on ${ORIGIN}`) },
		});
		expect(JSON.stringify(await h.run({ verb: "snapshot" }))).not.toContain("ada@clinic.test");
	});

	it("is refused on the Proton mailbox and asks nothing", async () => {
		const h = harness({ approval: "allow", tabs: [{ ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox" }] });
		expect(await h.run({ verb: "unmask", minutes: 15 })).toEqual({
			ok: false,
			error: expect.stringContaining("Proton Mail"),
		});
		expect(h.approvalRequests).toEqual([]);
	});

	it("shows email addresses in the page title and on console output during a grant", async () => {
		const h = harness({
			approval: "allow",
			tabs: [{ ...WEB_TAB, title: "ada@clinic.test - Users" }],
			pageResult: { started: false, entries: ["error for ada@clinic.test"] },
			mainResult: () => ({ entries: [] }),
		});
		await h.run({ verb: "unmask", minutes: 5 });
		const current = await h.run({ verb: "current" });
		expect(current.ok ? current.data.text : "").toContain("Page Title: ada@clinic.test - Users");
		const logged = await h.run({ verb: "console" });
		const text = logged.ok ? logged.data.text : "";
		expect(text).toContain("error for ada@clinic.test");
		expect(text).toContain(`unmasked on ${ORIGIN} until`);
	});

	it("masks a short secret fill value on success and error", async () => {
		const ok = harness({ approval: "allow", pageResult: { detail: "cvv 7391 set" } });
		await ok.run({ verb: "unmask", minutes: 15 });
		expect(JSON.stringify(await ok.run({ verb: "fill", target: "#cvv", value: "7391", secret: true }))).not.toContain("7391");
		const bad = harness({ approval: "allow", pageResult: { error: "bad cvv 7391" } });
		await bad.run({ verb: "unmask", minutes: 15 });
		expect(JSON.stringify(await bad.run({ verb: "fill", target: "#cvv", value: "7391", secret: true }))).not.toContain("7391");
	});

	it("keeps masking a filled secret in later replies of the session", async () => {
		const options = { approval: "allow" as const, pageResult: { detail: "filled" } as unknown };
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#otp", value: "739123", secret: true });
		options.pageResult = { tree: 'text "The code 739123 is not valid"', text: "The code 739123 is not valid" };
		expect(JSON.stringify(await h.run({ verb: "snapshot" }))).not.toContain("739123");
	});

	it("tells the MAIN world nothing about the grant or the held secrets", async () => {
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: (action: unknown) =>
				typeof action === "object" ? { api: "modelContext", tools: [] } : { entries: [] },
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 5 });
		await h.run({ verb: "fill", target: "#otp", value: "orchid-maple", secret: true });
		options.pageResult = { started: false, entries: [] };
		await h.run({ verb: "console" });
		await h.run({ verb: "tools" });
		const main = h.executed().filter((call) => call.world === "MAIN");
		expect(main.map((call) => call.args)).toEqual([[WEB_TAB.url], [{ kind: "tools" }, WEB_TAB.url]]);
		expect(JSON.stringify(main)).not.toContain("orchid-maple");
	});

	it("masks a held secret with a token-shaped part in raw MAIN-world console output", async () => {
		const secret = "sk-abcdefgh12345678 tail-passphrase";
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: () => ({ entries: [`[warning] login ${secret} done`] }),
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#pw", value: secret, secret: true });
		options.pageResult = { started: false, entries: [] };
		const text = outcome(await h.run({ verb: "console" }));
		expect(text).toContain("[warning] login [redacted] done");
		expect(text).not.toContain("tail-passphrase");
		expect(text).not.toContain("abcdefgh");
	});

	it("masks a held secret before it shortens a long MAIN-world console entry", async () => {
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: () => ({ entries: [`${"x".repeat(498)}739123x8 after`] }),
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#otp", value: "739123x8", secret: true });
		options.pageResult = { started: false, entries: [] };
		expect(outcome(await h.run({ verb: "console" }))).not.toContain("73");
	});

	it("masks the word at a MAIN-world cut, where a partial token no longer matches", async () => {
		const jwtStart = "eyJaaaaaaaaaa.eyJbb";
		const raw = `${" ".repeat(1960)}${jwtStart}`.slice(0, 2000);
		const h = harness({
			pageResult: { started: false, entries: [] },
			mainResult: () => ({ entries: [`${raw}…`] }),
		});
		const text = outcome(await h.run({ verb: "console" }));
		expect(text).not.toContain("eyJaaaaaaaaaa");
		expect(text).toContain("[redacted]…");
	});

	it("sends neither the grant nor held secrets with a WebMCP call", async () => {
		const h = harness({ approval: "allow", mainResult: () => ({ api: "modelContext", output: "ok" }) });
		await h.run({ verb: "unmask", minutes: 5 });
		await h.run({ verb: "call", tool: "search", args: {} });
		expect(h.executed().find((call) => call.world === "MAIN")?.args).toHaveLength(2);
	});

	it("masks the word at the cut of a MAIN-world error", async () => {
		const h = harness({ mainResult: () => ({ error: `WebMCP failed: ${"x ".repeat(240)}eyJaaaaaaaaaa.eyJbbbb…` }) });
		expect(outcome(await h.run({ verb: "call", tool: "search", args: {} }))).not.toContain("eyJaaaa");
	});

	it("masks a long cut output that ends in a credential pair quickly", async () => {
		const h = harness({ mainResult: () => ({ api: "modelContext", output: `${"a".repeat(99_000)} token=abcdefgh…` }) });
		const started = Date.now();
		expect(outcome(await h.run({ verb: "call", tool: "search", args: {} }))).not.toContain("abcdefgh");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("shortens a huge MAIN-world error before it masks it", async () => {
		const h = harness({ mainResult: () => ({ error: `boom ${"e".repeat(3_000_000)}` }) });
		const answer = await h.run({ verb: "call", tool: "search", args: {} });
		expect(outcome(answer).length).toBeLessThan(2_200);
	});

	it("keeps the old MAIN-world patterns: credential name suffixes and unsigned JWTs", async () => {
		const leaky = "client_secret=abcd1234xyz eyJaaaaaaaaaa.eyJbbbbbbbbbb.";
		const h = harness({
			pageResult: { started: false, entries: [] },
			mainResult: (action) =>
				typeof action === "object" ? { api: "modelContext", output: leaky } : { entries: [leaky] },
		});
		for (const text of [outcome(await h.run({ verb: "console" })), outcome(await h.run({ verb: "call", tool: "t", args: {} }))]) {
			expect(text).not.toContain("abcd1234xyz");
			expect(text).not.toContain("eyJbbbb");
		}
	});

	it("masks and bounds raw MAIN-world WebMCP text in the background", async () => {
		const h = harness({
			mainResult: (action) =>
				(action as { kind: string }).kind === "tools"
					? {
							api: "modelContext",
							tools: [
								{
									name: "search",
									description: `Bearer sk-abcdefgh12345678 ${"d".repeat(1900)}…`,
									inputSchema: '{"type":"object","default":"token=zzzzzzzzzzzz"}',
									annotations: `{"x":"${"a".repeat(900)}"}`,
								},
							],
						}
					: { api: "modelContext", output: `ada@clinic.test sk-outputzz12345678 ${"o".repeat(90_000)}` },
		});
		const listed = await h.run({ verb: "tools" });
		const tool = listed.ok ? listed.data.tools?.[0] : undefined;
		expect(tool?.description).toStartWith("Bearer [redacted] ");
		expect(tool?.description.length).toBeLessThanOrEqual(1001);
		expect(tool?.inputSchema).toBe('{"type":"object","default":"token=[redacted]"}');
		expect(tool?.annotations).toBeUndefined();
		expect(JSON.stringify(listed)).not.toContain("abcdefgh");
		const called = outcome(await h.run({ verb: "call", tool: "search", args: {} }));
		expect(called).not.toContain("ada@clinic.test");
		expect(called).not.toContain("sk-outputzz");
		expect(called.length).toBeLessThan(52_000);
	});

	it("masks the clipped start of a filled secret in MAIN-world console output", async () => {
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: () => ({ entries: [`${"x".repeat(497)}739…`] }),
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#otp", value: "739123", secret: true });
		options.pageResult = { started: false, entries: [] };
		expect(JSON.stringify(await h.run({ verb: "console" }))).not.toContain("739");
	});

	it("masks personal data again when the grant ends during a WebMCP call", async () => {
		const clock = { now: Date.UTC(2026, 10, 9, 15, 0) };
		const h = harness({
			approval: "allow",
			clock,
			mainResult: () => {
				clock.now += 16 * 60_000;
				return { api: "modelContext", output: "owner ada@example.com" };
			},
		});
		await h.run({ verb: "unmask", minutes: 15 });
		const text = outcome(await h.run({ verb: "call", tool: "search", args: {} }));
		expect(text).toContain("owner");
		expect(text).not.toContain("ada@example.com");
		expect(text).not.toContain("### Unmask");
	});

	it("masks personal data again when the tab leaves its group during a WebMCP call", async () => {
		let h: ReturnType<typeof harness>;
		h = harness({
			approval: "allow",
			mainResult: () => {
				const tab = h.fake.tabs.get(7);
				if (tab) tab.groupId = -1;
				return { api: "modelContext", output: "owner ada@example.com" };
			},
		});
		await h.run({ verb: "unmask", minutes: 15 });
		const text = outcome(await h.run({ verb: "call", tool: "search", args: {} }));
		expect(text).not.toContain("ada@example.com");
		expect(text).not.toContain("### Unmask");
	});

	it("does not fill a secret when the request is canceled while held secrets are read", async () => {
		const cancel = new AbortController();
		const h = harness({ approval: "allow", signal: cancel.signal, pageResult: { detail: "filled" } });
		await h.run({ verb: "unmask", minutes: 15 });
		const get = h.fake.raw.storage.session.get;
		const original = get.getMockImplementation();
		get.mockImplementation(async (keys?: string | string[] | null) => {
			if (keys === `pwExtSecrets:${SESSION}`) cancel.abort();
			return original?.(keys) as never;
		});
		const before = h.executed().length;
		expect(await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true })).toEqual({
			ok: false,
			error: expect.stringContaining("canceled"),
		});
		expect(h.executed()).toHaveLength(before);
	});

	it("holds no secret when the page refuses the fill", async () => {
		const options = {
			approval: "allow" as const,
			pageResult: { error: "--value-env and --value-stdin fill only a password or secret field." } as unknown,
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		expect(await h.run({ verb: "fill", target: "e2", value: "orchid-maple", secret: true })).toEqual({
			ok: false,
			error: expect.stringContaining("fill only a password or secret field"),
		});
		expect(await h.fake.api.storage.session.get(`pwExtSecrets:${SESSION}`)).toEqual({});
		options.pageResult = { tree: 'text "orchid-maple test"', text: "orchid-maple test" };
		await h.run({ verb: "unmask", off: true });
		const after = await h.run({ verb: "snapshot" });
		expect(outcome(after)).toContain("orchid-maple test");
		expect(h.executed().at(-1)?.args[3]).toEqual([]);
	});

	it("holds a secret before the fill runs, so a lost page reply still masks it later", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" } });
		await h.run({ verb: "unmask", minutes: 15 });
		let heldAtFill: unknown;
		h.fake.state.script = (details) => {
			heldAtFill = (details as { args: unknown[] }).args[3];
			throw new Error("the page reply was lost");
		};
		expect((await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true })).ok).toBe(false);
		expect(heldAtFill).toEqual(["orchid-maple"]);
		h.fake.state.script = () => ({ tree: 'text "orchid-maple"', text: "orchid-maple" });
		expect(JSON.stringify(await h.run({ verb: "snapshot" }))).not.toContain("orchid-maple");
	});

	it("keeps an already held secret when a later fill of it is refused", async () => {
		const options = { approval: "allow" as const, pageResult: { detail: "filled" } as unknown };
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true });
		options.pageResult = { error: "#pw cannot be filled." };
		await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true });
		options.pageResult = { tree: 'text "orchid-maple"', text: "orchid-maple" };
		expect(JSON.stringify(await h.run({ verb: "snapshot" }))).not.toContain("orchid-maple");
	});

	it.each(["x", "ab", "abc", "a \t\n "])("refuses a secret fill value shorter than 4 characters (%p)", async (value) => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" } });
		await h.run({ verb: "unmask", minutes: 15 });
		const before = h.executed().length;
		expect(await h.run({ verb: "fill", target: "#pw", value, secret: true })).toEqual({
			ok: false,
			error: expect.stringContaining("at least 4 characters"),
		});
		expect(h.executed()).toHaveLength(before);
		expect(await h.fake.api.storage.session.get(`pwExtSecrets:${SESSION}`)).toEqual({});
	});

	it("masks a filled secret that the tabs listing cap cuts in two", async () => {
		const secret = "739123";
		const listing = async (last: number) => {
			const tabs = Array.from({ length: 25 }, (_, i) =>
				groupTab(100 + i, { url: "https://a.example.test/", title: i === 24 ? `${"x".repeat(last)}${secret}` : "x".repeat(4000) }),
			);
			const h = harness({ approval: "allow", pageResult: { detail: "filled" }, tabs: [WEB_TAB, ...tabs] });
			await h.run({ verb: "unmask", minutes: 15 });
			await h.run({ verb: "fill", target: "#otp", value: secret, secret: true });
			return outcome(await h.run({ verb: "tabs" }));
		};
		const line = (await listing(4000)).indexOf("- 124: ");
		expect(line).toBeGreaterThan(0);
		const cut = PW_EXT_MAX_TEXT_CHARS - "\n[truncated]".length;
		const listed = await listing(cut - 3 - line - "- 124: ".length);
		expect(listed).toContain("[truncated]");
		expect(listed).not.toMatch(/x739/);
	});

	it("masks a filled secret in a later tabs listing", async () => {
		const options = { approval: "allow" as const, pageResult: { detail: "filled" } as unknown };
		const h = harness({ ...options, tabs: [{ ...WEB_TAB, title: "Code 739123 sent" }] });
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#otp", value: "739123", secret: true });
		expect(JSON.stringify(await h.run({ verb: "tabs" }))).not.toContain("739123");
	});

	it("gives each page action a deadline the page checks", async () => {
		const h = harness({ pageResult: { tree: "t", text: "x" } });
		const before = Date.now();
		await h.run({ verb: "snapshot" });
		const call = h.executed().find((entry) => (entry as { func?: { name?: string } }).func?.name === "pwExtPageAction");
		expect(call?.args[4]).toBeGreaterThanOrEqual(before + 15_000);
	});

	it("passes held secrets to the page so it masks them before it shortens text", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" } });
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#otp", value: "739123", secret: true });
		await h.run({ verb: "snapshot" });
		expect(h.executed().at(-1)?.args[3]).toEqual(["739123"]);
	});

	it("never echoes a secret fill value, even when the page repeats it", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled Temp-Pass-123" } });
		await h.run({ verb: "unmask", minutes: 15 });
		const answer = await h.run({ verb: "fill", target: "#pw", value: "Temp-Pass-123", secret: true });
		expect(JSON.stringify(answer)).not.toContain("Temp-Pass-123");
		expect(h.executed().at(-1)?.args[0]).toEqual({
			kind: "fill",
			target: "#pw",
			value: "Temp-Pass-123",
			secret: true,
			until: h.clock.now + 15 * 60_000,
		});
	});

	it("keeps a credential label masked when a filled secret is part of the label", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" }, tabs: [{ ...WEB_TAB, title: "password=opensesame-value" }] });
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#pw", value: "pass", secret: true });
		const text = outcome(await h.run({ verb: "current" }));
		expect(text).not.toContain("opensesame-value");
		expect(text).not.toContain("pass");
	});

	it("masks the whole filled secret when part of it looks like a token", async () => {
		const secret = "sk-abcdefgh12345678 tail-passphrase";
		const h = harness({ approval: "allow", pageResult: { detail: "filled" }, tabs: [{ ...WEB_TAB, title: `Hi ${secret}` }] });
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#pw", value: secret, secret: true });
		expect(outcome(await h.run({ verb: "current" }))).not.toContain("tail-passphrase");
		expect(outcome(await h.run({ verb: "tabs" }))).not.toContain("tail-passphrase");
	});

	it("masks a filled secret after the browser drops its line breaks", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" }, tabs: [{ ...WEB_TAB, title: "Hi orchidmaple" }] });
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#pw", value: "orchid\nmaple", secret: true });
		expect(outcome(await h.run({ verb: "current" }))).not.toContain("orchidmaple");
	});

	it("keeps masking a secret that one fill wrote when a concurrent fill of it fails", async () => {
		const options = { approval: "allow" as const, pageResult: { detail: "filled" } as unknown };
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 15 });
		let failFirst: (() => void) | undefined;
		let calls = 0;
		h.fake.state.script = () => {
			calls++;
			if (calls === 1)
				return new Promise((resolve) => {
					failFirst = () => resolve({ error: "#pw cannot be filled." });
				}) as never;
			return { detail: "filled" };
		};
		const first = h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true });
		const second = await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true });
		expect(second.ok).toBe(true);
		failFirst?.();
		expect((await first).ok).toBe(false);
		h.fake.state.script = () => ({ tree: 'text "orchid-maple"', text: "orchid-maple" });
		expect(JSON.stringify(await h.run({ verb: "snapshot" }))).not.toContain("orchid-maple");
	});

	it("does not fill a secret when the grant ends while held secrets are read", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" } });
		await h.run({ verb: "unmask", minutes: 15 });
		const get = h.fake.raw.storage.session.get;
		const original = get.getMockImplementation();
		get.mockImplementation(async (keys?: string | string[] | null) => {
			if (keys === `pwExtSecrets:${SESSION}`) h.clock.now += 16 * 60_000;
			return original?.(keys) as never;
		});
		const before = h.executed().length;
		expect(await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true })).toEqual({
			ok: false,
			error: expect.stringContaining("unmask ended"),
		});
		expect(h.executed()).toHaveLength(before);
	});
});

describe("pw --ext WebMCP approval", () => {
	const OWA = "https://outlook.live.com/mail/0/";
	const owaTab = { ...WEB_TAB, url: OWA, title: "Mail" };
	const ran = () => ({ api: "modelContext", output: "done" });

	it("asks before dg_outlook_delete with the tool, origin and ids, and runs only after Allow", async () => {
		const actions: unknown[] = [];
		const h = harness({
			tabs: [owaTab],
			approval: "allow",
			mainResult: (action) => {
				actions.push(action);
				return ran();
			},
		});
		const answer = await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["AAMkADQ1="] } });
		expect(h.approvalRequests).toEqual([
			expect.objectContaining({
				title: "Allow dg_outlook_delete on https://outlook.live.com?",
				origin: "https://outlook.live.com",
				lines: expect.arrayContaining([`Agent: ${IDENTITY}`, 'Args: {"ids":["AAMkADQ1="]}']),
			}),
		]);
		expect(actions).toHaveLength(1);
		expect(answer.ok && answer.data.text).toContain("done");
	});

	it("returns the deny error and does not run the tool", async () => {
		const actions: unknown[] = [];
		const h = harness({ tabs: [owaTab], approval: "deny", mainResult: (action) => void actions.push(action) });
		expect(await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["a"] } })).toEqual({
			ok: false,
			error: "The user denied dg_outlook_delete in the browser.",
		});
		expect(actions).toEqual([]);
	});

	it("returns the timeout error and does not run the tool", async () => {
		const actions: unknown[] = [];
		const h = harness({ tabs: [owaTab], approval: "timeout", mainResult: (action) => void actions.push(action) });
		expect(await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["a"] } })).toEqual({
			ok: false,
			error: "No answer in the browser within 60 seconds; dg_outlook_delete did not run.",
		});
		expect(actions).toEqual([]);
	});

	it("asks again on a second call of an each-class tool", async () => {
		const h = harness({ tabs: [owaTab], approval: "allow", mainResult: ran });
		await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["a"] } });
		await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["a"] } });
		expect(h.approvalRequests).toHaveLength(2);
	});

	it("asks once per session for a session-class tool and again for another session", async () => {
		const h = harness({ tabs: [owaTab], approval: "allow", mainResult: ran });
		h.fake.seedRecord(recordOf({ sessionId: OTHER_SESSION, agentIdentity: IDENTITY, groupId: GROUP, selectedTabId: 7 }));
		const move = { verb: "call", tool: "dg_outlook_move", args: { ids: ["a"], folder: "archive" } } as const;
		await h.run(move);
		await h.run(move);
		expect(h.approvalRequests).toHaveLength(1);
		await h.runAs(OTHER_SESSION, move);
		expect(h.approvalRequests).toHaveLength(2);
	});

	it("asks again when the stored session grant names another tab group", async () => {
		const h = harness({ tabs: [owaTab], approval: "allow", mainResult: ran });
		const move = { verb: "call", tool: "dg_outlook_move", args: { ids: ["a"], folder: "archive" } } as const;
		h.fake.api.storage.session.set({
			[`webmcpGrants:${SESSION}`]: [{ origin: "https://outlook.live.com", tool: "dg_outlook_move", groupId: OTHER_GROUP }],
		});
		await h.run(move);
		expect(h.approvalRequests).toHaveLength(1);
	});

	it("runs a read tool and a site tool without asking", async () => {
		const h = harness({ tabs: [owaTab], approval: "deny", mainResult: ran });
		expect((await h.run({ verb: "call", tool: "dg_outlook_list", args: {} })).ok).toBe(true);
		expect((await h.run({ verb: "call", tool: "search_flights", args: { to: "LIS" } })).ok).toBe(true);
		expect(h.approvalRequests).toEqual([]);
	});

	it("asks every time for an unknown dg_ tool", async () => {
		const h = harness({ tabs: [owaTab], approval: "allow", mainResult: ran });
		await h.run({ verb: "call", tool: "dg_outlook_unknown", args: {} });
		await h.run({ verb: "call", tool: "dg_outlook_unknown", args: {} });
		expect(h.approvalRequests).toHaveLength(2);
	});

	it("refuses a dg_ name that fails the name rule, asks nothing and runs nothing", async () => {
		const actions: unknown[] = [];
		const h = harness({ approval: "allow", mainResult: (action) => void actions.push(action) });
		expect(await h.run({ verb: "call", tool: "dg_x", args: {} })).toEqual({
			ok: false,
			error: "Unknown dg tool name dg_x.",
		});
		expect(h.approvalRequests).toEqual([]);
		expect(actions).toEqual([]);
	});

	it.each([
		["dg_outlook_delete", "closed", "The approval window was closed; dg_outlook_delete did not run."],
		["dg_outlook_delete", "unopened", "The approval window could not open; dg_outlook_delete did not run."],
		["dg_outlook_move", "closed", "The approval window was closed; dg_outlook_move did not run."],
		["dg_outlook_move", "unopened", "The approval window could not open; dg_outlook_move did not run."],
	] as const)("does not run %s and stores no grant when the answer is %s", async (tool, approval, error) => {
		const actions: unknown[] = [];
		const h = harness({ tabs: [owaTab], approval, mainResult: (action) => void actions.push(action) });
		expect(await h.run({ verb: "call", tool, args: { ids: ["a"] } })).toEqual({ ok: false, error });
		expect(actions).toEqual([]);
		expect(await h.fake.api.storage.session.get(`webmcpGrants:${SESSION}`)).toEqual({});
	});

	it("refuses and runs nothing when the tab leaves the group while the approval is open", async () => {
		const actions: unknown[] = [];
		let h: ReturnType<typeof harness>;
		h = harness({
			tabs: [owaTab],
			approval: "allow",
			onApproval: () => {
				const tab = h.fake.tabs.get(7);
				if (tab) tab.groupId = -1;
			},
			mainResult: (action) => void actions.push(action),
		});
		expect(await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["a"] } })).toEqual({
			ok: false,
			error: "The tab left the agent's group; dg_outlook_delete did not run.",
		});
		expect(actions).toEqual([]);
	});

	it("returns CANCELED and runs nothing when the request aborts during approval", async () => {
		const controller = new AbortController();
		const actions: unknown[] = [];
		const h = harness({
			tabs: [owaTab],
			approval: "allow",
			signal: controller.signal,
			onApproval: () => controller.abort(),
			mainResult: (action) => void actions.push(action),
		});
		expect(await h.run({ verb: "call", tool: "dg_outlook_delete", args: { ids: ["a"] } })).toEqual({
			ok: false,
			error: "The request was canceled before it ran.",
		});
		expect(actions).toEqual([]);
	});

	it("clips the args line to 600 characters and says how many were cut", async () => {
		const h = harness({ tabs: [owaTab], approval: "allow", mainResult: ran });
		await h.run({ verb: "call", tool: "dg_outlook_delete", args: { note: "n".repeat(5_000) } });
		const line = (h.approvalRequests[0] as { lines: string[] }).lines.find((entry) => entry.startsWith("Args: "));
		expect(line).toMatch(/^Args: .{600} \(\d+ more characters not shown\)$/);
	});

	it("fails cleanly when the tab has no URL", async () => {
		const h = harness({ tabs: [owaTab], approval: "allow", mainResult: ran });
		const tab = h.fake.tabs.get(7);
		if (tab) delete (tab as { url?: string }).url;
		expect((await h.run({ verb: "call", tool: "dg_outlook_delete", args: {} })).ok).toBe(false);
		expect(h.approvalRequests).toEqual([]);
	});
});

describe("pw --ext WebMCP on a mailbox tab", () => {
	const protonTab = { ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox", title: "Inbox" };
	const LISTING = {
		api: "modelContext",
		tools: [
			{ name: "dg_outlook_list", description: "List mail for ada@clinic.test", inputSchema: '{"type":"object"}' },
			{ name: "site_tool", description: "A site tool" },
			{ name: "dg_x", description: "Too short a name" },
			{ name: "dg_outlook_delete", description: "Delete mail" },
		],
	};

	const allEnabled = async () => new Set(["outlook"]);

	it.each(["dg_outlook_list", "dg_outlook_delete", "dg_proton_x"])(
		"refuses call %s on the Proton mailbox even with every built-in enabled",
		async (tool) => {
			const h = harness({
				tabs: [protonTab],
				approval: "allow",
				enabledBuiltIns: allEnabled,
				mainResult: () => ({ api: "modelContext", output: "[]" }),
			});
			expect(await h.run({ verb: "call", tool, args: {} })).toEqual({ ok: false, error: PW_EXT_MAILBOX_ERROR });
			expect(h.approvalRequests).toEqual([]);
			expect(h.executed()).toEqual([]);
		},
	);

	it("fails closed when the enabled built-ins cannot be read", async () => {
		const h = harness({
			tabs: [protonTab],
			enabledBuiltIns: async () => {
				throw new Error("storage down");
			},
			mainResult: () => LISTING,
		});
		expect(await h.run({ verb: "call", tool: "dg_outlook_list", args: {} })).toEqual({
			ok: false,
			error: PW_EXT_MAILBOX_ERROR,
		});
		const listed = await h.run({ verb: "tools" });
		expect(listed.ok && listed.data.tools).toEqual([]);
	});

	it("asks every time for a dg_ tool on a foreign origin even when its table class is session", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "https://evil.example/app" }],
			approval: "allow",
			mainResult: () => ({ api: "modelContext", output: "x" }),
		});
		await h.run({ verb: "call", tool: "dg_outlook_move", args: { ids: ["a"] } });
		await h.run({ verb: "call", tool: "dg_outlook_move", args: { ids: ["a"] } });
		expect(h.approvalRequests).toHaveLength(2);
	});

	it("asks nothing for dg_outlook_list on outlook.live.com", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "https://outlook.live.com/mail/0/" }],
			approval: "deny",
			mainResult: () => ({ api: "modelContext", output: "[]" }),
		});
		expect((await h.run({ verb: "call", tool: "dg_outlook_list", args: {} })).ok).toBe(true);
		expect(h.approvalRequests).toEqual([]);
	});

	it("replaces a page-sourced error on the mailbox tab with a fixed message", async () => {
		const h = harness({
			tabs: [protonTab],
			approval: "allow",
			mainResult: () => ({ error: "leak@x.com secret text" }),
		});
		const fixed = { ok: false as const, error: "The WebMCP tool failed on the protected mailbox tab." };
		expect(await h.run({ verb: "tools" })).toEqual(fixed);
	});

	it.each(["site_tool", "dg_x", "search_flights"])("refuses call %s with the mailbox error", async (tool) => {
		const h = harness({ tabs: [protonTab], approval: "allow", mainResult: () => ({ api: "modelContext", output: "x" }) });
		expect(await h.run({ verb: "call", tool, args: {} })).toEqual({ ok: false, error: PW_EXT_MAILBOX_ERROR });
		expect(h.approvalRequests).toEqual([]);
		expect(h.executed()).toEqual([]);
	});

	it("leaves out every tool the mailbox rule does not allow, in text and data.tools", async () => {
		const h = harness({
			tabs: [protonTab],
			enabledBuiltIns: allEnabled,
			mainResult: () => ({ ...LISTING, tools: [...LISTING.tools, { name: "dg_proton_x", description: "Proton tool" }] }),
		});
		const answer = await h.run({ verb: "tools" });
		if (!answer.ok) throw new Error(answer.error);
		expect(answer.data.tools).toEqual([]);
		for (const name of ["dg_outlook_list", "dg_outlook_delete", "dg_proton_x", "site_tool", "dg_x"])
			expect(answer.data.text).not.toContain(name);
		expect(answer.data.text).toContain("This page exposes no WebMCP tools.");
	});

	it("filters in the background, so the page function sees no name filter", async () => {
		const h = harness({ tabs: [protonTab], mainResult: () => LISTING });
		await h.run({ verb: "tools" });
		expect(h.executed().at(-1)?.args[0]).toEqual({ kind: "tools" });
	});

	it("says there are no tools when the page lists none with a dg_ name", async () => {
		const h = harness({
			tabs: [protonTab],
			mainResult: () => ({ api: "modelContext", tools: [{ name: "site_tool", description: "s" }] }),
		});
		const answer = await h.run({ verb: "tools" });
		expect(answer.ok && answer.data.text).toContain("This page exposes no WebMCP tools.");
		expect(answer.ok && answer.data.tools).toEqual([]);
	});

	it.each(["snapshot", "click", "fill", "count", "selection", "console", "screenshot", "unmask", "upload"] as const)(
		"still refuses %s",
		async (verb) => {
			const h = harness({ tabs: [protonTab], approval: "allow" });
			const request = {
				snapshot: { verb: "snapshot" },
				click: { verb: "click", target: "e1" },
				fill: { verb: "fill", target: "e1", value: "x" },
				count: { verb: "count", target: "e1" },
				selection: { verb: "selection" },
				console: { verb: "console" },
				screenshot: { verb: "screenshot" },
				unmask: { verb: "unmask", minutes: 5 },
				upload: {
					verb: "upload",
					target: "#file",
					assetId: "123e4567-e89b-42d3-a456-426614174000",
					fileName: "f.txt",
					fileSize: 1,
					fileType: "text/plain",
					filePath: "~/f.txt",
				},
			}[verb] as PwExtRequest;
			expect(await h.run(request)).toEqual({ ok: false, error: PW_EXT_MAILBOX_ERROR });
		},
	);
});

describe("pw --ext tools verb data", () => {
	it("returns data.tools beside the text on a normal page", async () => {
		const h = harness({
			mainResult: () => ({
				api: "modelContext",
				tools: [{ name: "search", description: "Search issues", inputSchema: '{"type":"object"}' }],
			}),
		});
		const answer = await h.run({ verb: "tools" });
		expect(answer).toEqual({
			ok: true,
			data: {
				text: expect.stringContaining("- search: Search issues"),
				tools: [{ name: "search", description: "Search issues", inputSchema: '{"type":"object"}' }],
			},
		});
	});

	it("redacts a token in data.tools the same as in the text", async () => {
		const h = harness({
			mainResult: () => ({
				api: "modelContext",
				tools: [{ name: "search", description: "Search with token=zzzzzzzzzzzz" }],
			}),
		});
		const answer = await h.run({ verb: "tools" });
		expect(JSON.stringify(answer)).not.toContain("zzzzzzzzzzzz");
	});
});

describe("pw --ext call output", () => {
	const OUTPUT = { api: "modelContext", output: '{"from":"ada@clinic.test"}' };

	it("keeps an email address under an active unmask grant and redacts it without one", async () => {
		const h = harness({
			approval: "allow",
			mainResult: () => OUTPUT,
		});
		const before = await h.run({ verb: "call", tool: "dg_outlook_list", args: {} });
		expect(JSON.stringify(before)).not.toContain("ada@clinic.test");
		expect(JSON.stringify(before)).toContain("[redacted]");
		await h.run({ verb: "unmask", minutes: 5 });
		const after = await h.run({ verb: "call", tool: "dg_outlook_list", args: {} });
		expect(JSON.stringify(after)).toContain("ada@clinic.test");
	});

	it("passes an OWA item id through unchanged", async () => {
		const id = "AAMkADQ1ZTI3LTc0OWUtNGMwNS1iYjJmLWQ5MGI4OGE4ZTM1NQBGAAAAAAAbc9WvQ1k3RYaQ0q7yB8HaBwDfDYlFqjH4QZxAu3SVPHaQAAAAAAEMAADfDYlFqjH4QZxAu3SVPHaQAAB5mYQmAAA=";
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "https://outlook.live.com/mail/0/" }],
			mainResult: () => ({ api: "modelContext", output: JSON.stringify({ items: [{ id }] }) }),
		});
		const answer = await h.run({ verb: "call", tool: "dg_outlook_list", args: {} });
		expect(answer.ok && answer.data.text).toContain(id);
	});
});

describe("pw --ext data.tools redaction", () => {
	const LISTING = {
		api: "modelContext",
		tools: [
			{ name: "pick_hunter2secret", description: "d" },
			{ name: "access_token=abc123xyz", description: "d" },
			{ name: "plain", description: "mail ada@clinic.test" },
		],
	};

	it("redacts a filled secret literal and a token pair in tool names, as the text does", async () => {
		const h = harness({ approval: "allow", pageResult: { detail: "filled" }, mainResult: () => LISTING });
		await h.run({ verb: "unmask", minutes: 15 });
		await h.run({ verb: "fill", target: "#pw", value: "hunter2secret", secret: true });
		const answer = await h.run({ verb: "tools" });
		if (!answer.ok) throw new Error(answer.error);
		const dump = JSON.stringify(answer.data.tools);
		expect(dump).not.toContain("hunter2secret");
		expect(dump).not.toContain("abc123xyz");
		expect(answer.data.text).not.toContain("hunter2secret");
	});

	it("redacts emails in data.tools when the unmask grant ends during the request", async () => {
		const clock = { now: Date.UTC(2026, 10, 9, 15, 0) };
		const h = harness({
			approval: "allow",
			clock,
			mainResult: () => {
				clock.now += 16 * 60_000;
				return LISTING;
			},
		});
		await h.run({ verb: "unmask", minutes: 15 });
		const answer = await h.run({ verb: "tools" });
		if (!answer.ok) throw new Error(answer.error);
		expect(JSON.stringify(answer.data.tools)).not.toContain("ada@clinic.test");
	});

	it("keeps an email in data.tools during an active grant", async () => {
		const h = harness({ approval: "allow", mainResult: () => LISTING });
		await h.run({ verb: "unmask", minutes: 15 });
		const answer = await h.run({ verb: "tools" });
		expect(answer.ok && JSON.stringify(answer.data.tools)).toContain("ada@clinic.test");
	});
});

describe("pw --ext dialog", () => {
	const at = Date.UTC(2026, 10, 12, 9, 0);
	const confirmDelete = {
		type: "confirm",
		message: "Delete the item? token=zzzzzzzzzzzz ada@clinic.test",
		answer: "dismiss",
		by: "default",
		seen: false,
		at,
	};
	const dialogCalls = (h: ReturnType<typeof harness>) =>
		h.executed().filter((call) => call.world === "MAIN" && (call as { func?: { name?: string } }).func?.name === "pwExtDialogs");

	it("shows the last dialog, how it was answered, and the answer set for the next one, all masked", async () => {
		const h = harness({
			mainResult: () => ({ dialogs: [confirmDelete], pending: { answer: "accept", withText: false } }),
		});
		const text = outcome(await h.run({ verb: "dialog" }));
		expect(text).toContain("### Dialog");
		expect(text).toContain('- last: confirm "Delete the item? token=[redacted] [redacted]", dismissed by default');
		expect(text).toContain("- next: accept");
		expect(dialogCalls(h).map((call) => call.args)).toEqual([
			[{ kind: "install" }, WEB_TAB.url, GROUP],
			[{ kind: "read", markSeen: true }, WEB_TAB.url, GROUP],
		]);
	});

	it("says when the page showed no dialog", async () => {
		const h = harness({ mainResult: () => ({ dialogs: [] }) });
		expect(outcome(await h.run({ verb: "dialog" }))).toContain("No dialog on this page since pw --ext began to watch it.");
	});

	it("sets a one-shot answer with prompt text", async () => {
		const h = harness({ mainResult: () => ({ dialogs: [], pending: { answer: "accept", withText: true } }) });
		const answer = await h.run({ verb: "dialog", answer: "accept", text: "Grace" });
		expect(outcome(answer)).toContain("The next dialog on this page gets accept, with your text.");
		expect(dialogCalls(h).map((call) => call.args)).toEqual([
			[{ kind: "install" }, WEB_TAB.url, GROUP],
			[{ kind: "answer", answer: "accept", text: "Grace", until: expect.any(Number) }, WEB_TAB.url, GROUP],
		]);
	});

	it("refuses prompt text that holds a filled secret and sends nothing to the page", async () => {
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: () => ({ dialogs: [] }),
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 5 });
		await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true });
		const answer = await h.run({ verb: "dialog", answer: "accept", text: "my orchid-maple" });
		expect(answer.ok).toBe(false);
		expect(outcome(answer)).toContain("filled as a secret");
		expect(outcome(answer)).not.toContain("orchid-maple");
		expect(dialogCalls(h)).toEqual([]);
	});

	it("refuses the mailbox and browser pages", async () => {
		const proton = harness({ tabs: [{ ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox" }] });
		expect((await proton.run({ verb: "dialog" })).ok).toBe(false);
		const settings = harness({ tabs: [{ ...WEB_TAB, url: "chrome://settings/" }] });
		expect((await settings.run({ verb: "dialog", answer: "dismiss" })).ok).toBe(false);
		expect([...dialogCalls(proton), ...dialogCalls(settings)]).toEqual([]);
	});

	it("rejects a malformed dialog reply from the page", async () => {
		const h = harness({ mainResult: () => ({ dialogs: [{ ...confirmDelete, type: "beforeunload" }] }) });
		expect(await h.run({ verb: "dialog" })).toEqual({ ok: false, error: "The page returned an unexpected dialog result." });
	});

	it("lists unseen dialogs and the next answer at the top of a snapshot, read before the page action", async () => {
		const h = harness({
			pageResult: { tree: 'button "Delete" [ref=e1]', text: "Items" },
			mainResult: () => ({ dialogs: [{ ...confirmDelete, seen: true }, { ...confirmDelete, type: "alert", message: "Gone" }], pending: { answer: "dismiss", withText: false } }),
		});
		const text = outcome(await h.run({ verb: "snapshot" }));
		expect(text).toContain('### Dialog\n- alert "Gone", dismissed by default\n- next: dismiss');
		expect(text).not.toContain("Delete the item?");
		expect(dialogCalls(h).map((call) => call.args)).toEqual([
			[{ kind: "install" }, WEB_TAB.url, GROUP],
			[{ kind: "read", markSeen: true }, WEB_TAB.url, GROUP],
		]);
		expect(h.executed().at(-1)?.world).toBeUndefined();
	});

	it("keeps the snapshot when the dialog read fails", async () => {
		const h = harness({ pageResult: { tree: 'button "Go" [ref=e1]', text: "Go" }, mainResult: () => "nonsense" });
		const answer = await h.run({ verb: "snapshot" });
		expect(answer.ok).toBe(true);
		expect(outcome(answer)).not.toContain("### Dialog");
	});

	it("installs the shim as early as it can in agent tabs of any session, and in no user tab", async () => {
		const h = harness({
			tabs: [
				WEB_TAB,
				groupTab(8, { url: "https://mail.proton.me/u/0/inbox" }),
				groupTab(9, { url: "https://app.example.test/", incognito: true }),
				groupTab(10, { url: "chrome://settings/" }),
			],
		});
		for (const tabId of [7, 8, 9, 10, 20, 21]) h.fake.fireUpdated(tabId, { status: "loading" });
		h.fake.fireUpdated(7, { title: "x" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const installs = dialogCalls(h);
		expect(installs.map((call) => call.target.tabId)).toEqual([7, 20]);
		expect(installs[0]).toMatchObject({ world: "MAIN", injectImmediately: true, args: [{ kind: "install" }, WEB_TAB.url, GROUP] });
	});

	it("removes the shim when a tab leaves its agent group, and installs it when a tab joins one", async () => {
		const h = harness();
		const tab = h.fake.tabs.get(7) as FakeTab;
		tab.groupId = -1;
		h.fake.fireUpdated(7, { groupId: -1 });
		const user = h.fake.tabs.get(21) as FakeTab;
		user.groupId = GROUP;
		h.fake.fireUpdated(21, { groupId: GROUP });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(dialogCalls(h).map((call) => [call.target.tabId, call.args[0]])).toEqual([
			[7, { kind: "remove" }],
			[21, { kind: "install" }],
		]);
	});

	it("still removes the shim when a load event follows the group change", async () => {
		const h = harness();
		h.fake.fireUpdated(7, { status: "loading" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		(h.fake.tabs.get(7) as FakeTab).groupId = -1;
		h.fake.fireUpdated(7, { groupId: -1 });
		h.fake.fireUpdated(7, { status: "complete" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(dialogCalls(h).map((call) => call.args[0])).toEqual([{ kind: "install" }, { kind: "remove" }, { kind: "remove" }]);
	});

	it("keeps sending removals on later loads of a tab it once shimmed, for pages the back-forward cache restores", async () => {
		const h = harness();
		h.fake.fireUpdated(7, { status: "loading" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		(h.fake.tabs.get(7) as FakeTab).groupId = -1;
		h.fake.fireUpdated(7, { groupId: -1 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		h.fake.fireUpdated(7, { status: "complete" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(dialogCalls(h).map((call) => call.args[0])).toEqual([{ kind: "install" }, { kind: "remove" }, { kind: "remove" }]);
	});

	it("still removes the shim from a released tab after a worker restart", async () => {
		const h = harness();
		h.fake.fireUpdated(7, { status: "loading" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		(h.fake.tabs.get(7) as FakeTab).groupId = -1;
		const restarted = createPwExtHandler({ browserApi: h.fake.api, agentTabs: h.agentTabs, isChromium: () => true, lock: h.agentTabsLock });
		expect(restarted).toBeInstanceOf(Function);
		h.fake.fireUpdated(7, { status: "complete" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(dialogCalls(h).map((call) => call.args[0])).toContainEqual({ kind: "remove" });
		expect(h.fake.session.get("pwExtDialogShims")).toEqual([7]);
	});

	it("installs the shim right after new opens a tab", async () => {
		const h = harness({ record: false });
		await h.run({ verb: "new", url: "https://app.example.test/" });
		const tab = await h.createdTab();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(dialogCalls(h).map((call) => [call.target.tabId, call.args[0]])).toEqual([[tab.id, { kind: "install" }]]);
	});

	it("stops waiting on a tab that does not answer when the session ends", async () => {
		const h = harness();
		h.fake.state.script = () => new Promise(() => {});
		const started = Date.now();
		await forgetAgentTabsAndShims({ browserApi: h.fake.api, storage: h.fake.api.storage, lock: h.agentTabsLock, agentTabs: h.agentTabs, sessionId: SESSION, deadlineMs: 20 });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(h.fake.record(SESSION)).toBeUndefined();
	});

	it("also removes the shim from a tab the session got after the cleanup listed its tabs", async () => {
		const h = harness({ tabs: [WEB_TAB, groupTab(8, { url: "https://late.example.test/" })] });
		h.fake.fireUpdated(8, { status: "loading" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const agentTabs = { list: async () => [], forget: h.agentTabs.forget.bind(h.agentTabs) };
		await forgetAgentTabsAndShims({ browserApi: h.fake.api, storage: h.fake.api.storage, lock: h.agentTabsLock, agentTabs, sessionId: SESSION });
		expect(dialogCalls(h).filter((call) => call.target.tabId === 8).map((call) => call.args[0])).toEqual([
			{ kind: "install" },
			{ kind: "remove" },
		]);
	});

	it("removes the shim from a forgotten session's tabs, and skips mailbox and browser pages", async () => {
		const h = harness({
			tabs: [WEB_TAB, groupTab(8, { url: "https://mail.proton.me/u/0/inbox" }), groupTab(10, { url: "chrome://settings/" })],
		});
		await forgetAgentTabsAndShims({ browserApi: h.fake.api, storage: h.fake.api.storage, lock: h.agentTabsLock, agentTabs: h.agentTabs, sessionId: SESSION });
		expect(dialogCalls(h).map((call) => [call.target.tabId, call.args])).toEqual([[7, [{ kind: "remove" }]]]);
		expect(h.fake.record(SESSION)).toBeUndefined();
	});

	it("does not wait on the shim before new and select answer", async () => {
		const h = harness();
		h.fake.state.script = () => new Promise(() => {});
		expect((await h.run({ verb: "select", tabId: 7 })).ok).toBe(true);
	});

	it("refuses prompt text that holds a filled secret without its line breaks", async () => {
		const options = { approval: "allow" as const, pageResult: { detail: "filled" } as unknown, mainResult: () => ({ dialogs: [] }) };
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 5 });
		await h.run({ verb: "fill", target: "#pw", value: "orchid\nmaple", secret: true });
		expect((await h.run({ verb: "dialog", answer: "accept", text: "orchidmaple" })).ok).toBe(false);
		expect(dialogCalls(h)).toEqual([]);
	});

	it("removes the shim again when the tab stopped being an agent tab during the install", async () => {
		const h = harness();
		h.fake.state.script = (details) => {
			const call = details as { args: unknown[] };
			if ((call.args[0] as { kind?: string }).kind === "install") h.fake.session.delete("agentTabs:" + SESSION);
			return { dialogs: [] };
		};
		h.fake.fireUpdated(7, { status: "loading" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(dialogCalls(h).map((call) => call.args[0])).toEqual([{ kind: "install" }, { kind: "remove" }]);
	});

	it("masks a dialog error with a secret that a concurrent fill holds", async () => {
		let release: (() => void) | undefined;
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: (action: unknown) =>
				(action as { kind: string }).kind === "install"
					? { dialogs: [] }
					: new Promise((resolve) => {
							release = () => resolve({ error: "Dialog handling failed: lilac-harbor" });
						}),
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 5 });
		const reading = h.run({ verb: "dialog" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await h.run({ verb: "fill", target: "#pw", value: "lilac-harbor", secret: true });
		release?.();
		expect(outcome(await reading)).not.toContain("lilac-harbor");
	});

	it("waits for an adopt in flight before it decides a regrouped tab is no agent tab", async () => {
		const h = harness();
		let finish: (() => void) | undefined;
		const holding = h.agentTabsLock.request("agentTabs", () => new Promise<void>((resolve) => (finish = resolve)));
		(h.fake.tabs.get(21) as FakeTab).groupId = 30;
		h.fake.fireUpdated(21, { groupId: 30 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		h.fake.seedRecord(recordOf({ sessionId: "adopting", groupId: 30 }));
		finish?.();
		await holding;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(dialogCalls(h).map((call) => call.args[0])).toEqual([{ kind: "install" }]);
	});

	it("masks a page-made dialog error with the held secrets", async () => {
		const options = {
			approval: "allow" as const,
			pageResult: { detail: "filled" } as unknown,
			mainResult: () => ({ error: "Dialog handling failed: orchid-maple" }),
		};
		const h = harness(options);
		await h.run({ verb: "unmask", minutes: 5 });
		await h.run({ verb: "fill", target: "#pw", value: "orchid-maple", secret: true });
		const answer = await h.run({ verb: "dialog" });
		expect(answer.ok).toBe(false);
		expect(outcome(answer)).not.toContain("orchid-maple");
	});

	it("names a possible dialog when the page does not answer in time", async () => {
		const h = harness({ pageResult: new Promise(() => {}), pageDeadlineMs: 20 });
		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("It may show a dialog that pw --ext could not catch"),
		});
	});
});

describe("pw --ext site allowlist", () => {
	const ORIGIN = "https://app.example.test";

	it("asks once per origin in a session, then runs", async () => {
		const h = harness({ sites: "ask", approval: "allow", pageResult: { tree: "t", text: "x" } });
		expect((await h.run({ verb: "snapshot" })).ok).toBe(true);
		expect((await h.run({ verb: "snapshot" })).ok).toBe(true);
		expect(h.approvalRequests).toEqual([
			expect.objectContaining({
				title: "Allow the agent on example.test and its subdomains for this session?",
				origin: ORIGIN,
				lines: expect.arrayContaining([`Agent: ${IDENTITY}`, "Host: app.example.test"]),
			}),
		]);
	});

	it("touches no page when the person denies the site", async () => {
		const h = harness({ sites: "ask", approval: "deny", pageResult: { tree: "t", text: "x" } });
		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("may not use example.test and its subdomains"),
		});
		expect(h.executed()).toEqual([]);
	});

	it("asks for the target origin of open and new", async () => {
		const h = harness({ sites: "ask", approval: "allow" });
		await h.run({ verb: "open", url: "https://next.example.test/a" });
		await h.run({ verb: "new", url: "https://third.example.org/" });
		await h.run({ verb: "new" });
		expect(h.approvalRequests.map((request) => (request as { origin: string }).origin)).toEqual([
			"https://next.example.test",
			"https://third.example.org",
		]);
	});

	it("does not act on a tab that left the group while the site popup was open", async () => {
		const options = {
			sites: "ask" as const,
			approval: "allow" as const,
			pageResult: { detail: "clicked" },
			onApproval: () => undefined as void,
		};
		const h = harness(options);
		options.onApproval = () => {
			(h.fake.tabs.get(7) as FakeTab).groupId = -1;
		};
		const answer = await h.run({ verb: "click", target: "e1" });
		expect(answer.ok).toBe(false);
		expect(h.executed().filter((call) => (call as { func?: { name?: string } }).func?.name === "pwExtPageAction")).toEqual([]);
	});

	it("does nothing when the page changed while the site popup was open", async () => {
		const options = { sites: "ask" as const, approval: "allow" as const, onApproval: () => undefined as void };
		const h = harness(options);
		options.onApproval = () => {
			(h.fake.tabs.get(7) as FakeTab).url = "https://mail.proton.me/u/0/inbox";
		};
		expect(await h.run({ verb: "open", url: "https://app.example.test/next" })).toEqual({
			ok: false,
			error: expect.stringContaining("The page changed while the site question was open"),
		});
		expect(h.fake.raw.tabs.update).not.toHaveBeenCalled();
	});

	it("asks once when two verbs reach a new site at the same time", async () => {
		const h = harness({ sites: "ask", approval: "allow", pageResult: { text: "x" } });
		const answers = await Promise.all([h.run({ verb: "selection" }), h.run({ verb: "selection" })]);
		expect(answers.map((answer) => answer.ok)).toEqual([true, true]);
		expect(h.approvalRequests).toHaveLength(1);
	});

	it("saves a shared Allow for a request that is still live when the asking one was canceled", async () => {
		const controller = new AbortController();
		const h = harness({ sites: "ask", approval: "allow", pageResult: { text: "x" }, onApproval: () => controller.abort() });
		const first = h.handler({ request: { verb: "selection" }, timeoutMs: 60_000, signal: controller.signal, progress: () => undefined, context: { sessionId: SESSION, agentIdentity: IDENTITY } } as never);
		const second = h.run({ verb: "selection" });
		await Promise.all([first, second]);
		expect(h.fake.session.get(`pwExtSites:${SESSION}`)).toEqual(["https://example.test"]);
	});

	it("asks once for login.live.com, then not for other live.com hosts", async () => {
		const h = harness({
			sites: "ask",
			approval: "allow",
			pageResult: { text: "x" },
			tabs: [{ ...WEB_TAB, url: "https://login.live.com/oauth20_authorize.srf" }],
		});
		expect((await h.run({ verb: "selection" })).ok).toBe(true);
		(h.fake.tabs.get(7) as FakeTab).url = "https://account.live.com/proofs";
		expect((await h.run({ verb: "selection" })).ok).toBe(true);
		expect((await h.run({ verb: "open", url: "https://outlook.live.com/mail/0/" })).ok).toBe(true);
		expect(h.approvalRequests).toEqual([
			expect.objectContaining({
				title: "Allow the agent on live.com and its subdomains for this session?",
				origin: "https://login.live.com",
				lines: expect.arrayContaining(["Host: login.live.com"]),
			}),
		]);
	});

	it("asks separately for outlook.cloud.microsoft and microsoft.com", async () => {
		const h = harness({ sites: "ask", approval: "allow" });
		await h.run({ verb: "new", url: "https://www.microsoft.com/" });
		await h.run({ verb: "new", url: "https://outlook.cloud.microsoft/mail/" });
		await h.run({ verb: "new", url: "https://learn.microsoft.com/" });
		expect(h.approvalRequests.map((request) => (request as { title: string }).title)).toEqual([
			"Allow the agent on microsoft.com and its subdomains for this session?",
			"Allow the agent on cloud.microsoft and its subdomains for this session?",
		]);
	});

	it("asks separately for two github.io tenants", async () => {
		const h = harness({ sites: "ask", approval: "allow" });
		await h.run({ verb: "new", url: "https://a.github.io/" });
		await h.run({ verb: "new", url: "https://b.github.io/" });
		await h.run({ verb: "new", url: "https://a.github.io/other" });
		expect(h.approvalRequests.map((request) => (request as { origin: string }).origin)).toEqual([
			"https://a.github.io",
			"https://b.github.io",
		]);
	});

	it("names an exact host without subdomains for localhost", async () => {
		const h = harness({ sites: "ask", approval: "allow" });
		await h.run({ verb: "new", url: "http://localhost:3000/" });
		await h.run({ verb: "new", url: "http://localhost:8080/" });
		expect(h.approvalRequests.map((request) => (request as { title: string }).title)).toEqual([
			"Allow the agent on http://localhost:3000 for this session?",
			"Allow the agent on http://localhost:8080 for this session?",
		]);
	});

	it("shows one popup when verbs reach two hosts of one domain at the same time", async () => {
		const h = harness({
			sites: "ask",
			approval: "allow",
			onApproval: () => new Promise((resolve) => setTimeout(resolve, 10)),
		});
		const answers = await Promise.all([
			h.run({ verb: "new", url: "https://login.live.com/" }),
			h.run({ verb: "new", url: "https://outlook.live.com/mail/0/" }),
			h.run({ verb: "new", url: "https://live.com/" }),
		]);
		expect(answers.map((answer) => answer.ok)).toEqual([true, true, true]);
		expect(h.approvalRequests).toHaveLength(1);
	});

	it("asks once in a redirect chain on one domain, and once more for a new domain", async () => {
		const options = {
			sites: "ask" as const,
			approval: "allow" as const,
			pageResult: { text: "x" },
			tabs: [{ ...WEB_TAB, url: "https://login.live.com/oauth20_authorize.srf" }],
			onApproval: () => undefined as void,
		};
		const h = harness(options);
		options.onApproval = () => {
			(h.fake.tabs.get(7) as FakeTab).url = "https://account.live.com/proofs";
		};
		expect(await h.run({ verb: "selection" })).toEqual({
			ok: false,
			error: expect.stringContaining("The page changed while the site question was open"),
		});
		options.onApproval = () => undefined;
		(h.fake.tabs.get(7) as FakeTab).url = "https://outlook.live.com/owa/";
		expect((await h.run({ verb: "open", url: "https://login.live.com/ppsecure" })).ok).toBe(true);
		expect(h.approvalRequests).toHaveLength(1);
		(h.fake.tabs.get(7) as FakeTab).url = "https://login.microsoftonline.com/common/oauth2";
		expect((await h.run({ verb: "selection" })).ok).toBe(true);
		expect((await h.run({ verb: "selection" })).ok).toBe(true);
		expect(h.approvalRequests.map((request) => (request as { origin: string }).origin)).toEqual([
			"https://login.live.com",
			"https://login.microsoftonline.com",
		]);
	});

	it("does not ask again after a Deny for verbs sent before the answer, and asks a later verb", async () => {
		const options = {
			sites: "ask" as const,
			approval: "deny" as const,
			pageResult: { text: "x" },
			onApproval: () => undefined as void,
		};
		const h = harness(options);
		let queued: ReturnType<typeof h.run> | undefined;
		options.onApproval = () => {
			queued ??= h.run({ verb: "selection" });
		};
		expect((await h.run({ verb: "selection" })).ok).toBe(false);
		expect(await queued).toEqual({ ok: false, error: expect.stringContaining("clicked Deny") });
		expect(h.approvalRequests).toHaveLength(1);
		expect((await h.run({ verb: "selection" })).ok).toBe(false);
		expect(h.approvalRequests).toHaveLength(2);
	});

	it("asks nothing for tabs, select and close", async () => {
		const h = harness({ sites: "ask", tabs: [WEB_TAB, groupTab(8, { url: "https://other.example.test/" })] });
		await h.run({ verb: "tabs" });
		await h.run({ verb: "select", tabId: 8 });
		await h.run({ verb: "close", tabId: 8 });
		expect(h.approvalRequests).toEqual([]);
	});
});

describe("pw --ext Stop", () => {
	const STOPPED = expect.stringContaining("clicked Stop");

	it("ends the session's control: grants, sites and tab record go, and later verbs are refused", async () => {
		const h = harness({ sites: "ask", approval: "allow", pageResult: { tree: "t", text: "x" } });
		await h.run({ verb: "snapshot" });
		await h.run({ verb: "unmask", minutes: 5 });
		await h.handler.stop(SESSION);
		expect(await h.run({ verb: "snapshot" })).toEqual({ ok: false, error: STOPPED });
		expect(await h.run({ verb: "tabs" })).toEqual({ ok: false, error: STOPPED });
		expect(h.fake.record(SESSION)).toBeUndefined();
		expect([...h.fake.session.keys()].filter((key) => key.endsWith(SESSION))).toEqual([`pwExtStopped:${SESSION}`]);
		expect((await h.runAs(OTHER_SESSION, { verb: "tabs" })).ok).toBe(true);
	});

	it("cancels a verb in flight at once with the Stop error", async () => {
		const h = harness({ sites: "ask", approval: "allow", pageResult: new Promise(() => {}) });
		const running = h.run({ verb: "snapshot" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await h.handler.stop(SESSION);
		expect(await running).toEqual({ ok: false, error: STOPPED });
	});

	it("keeps no dg_ grant that an Allow gives after Stop", async () => {
		let asked = 0;
		const options = {
			sites: "ask" as const,
			approval: "allow" as const,
			tabs: [{ ...WEB_TAB, url: "https://outlook.live.com/mail/0/", title: "Mail" }],
			mainResult: () => ({ api: "modelContext", output: "done" }),
			onApproval: () => undefined as void,
		};
		const h = harness(options);
		options.onApproval = () => {
			if (++asked === 2) void h.handler.stop(SESSION);
		};
		const answer = await h.run({ verb: "call", tool: "dg_outlook_move", args: { ids: ["a"], folder: "archive" } });
		expect(answer).toEqual({ ok: false, error: STOPPED });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.fake.session.has(`webmcpGrants:${SESSION}`)).toBe(false);
	});

	it("closes no tab when Stop comes while close waits for the agent tab lock", async () => {
		const h = harness({ sites: "ask", tabs: [WEB_TAB, groupTab(8)] });
		let release: (() => void) | undefined;
		const holding = h.agentTabsLock.request("agentTabs", () => new Promise<void>((resolve) => (release = resolve)));
		const closing = h.run({ verb: "close", tabId: 8 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const stopping = h.handler.stop(SESSION);
		expect(await closing).toEqual({ ok: false, error: STOPPED });
		release?.();
		await holding;
		await stopping;
		expect(h.fake.raw.tabs.remove).not.toHaveBeenCalled();
	});

	it("opens no tab when Stop comes while new waits for the agent tab lock", async () => {
		const h = harness({ sites: "ask", record: false, approval: "allow" });
		await h.run({ verb: "new", url: "https://next.example.test/" });
		const before = h.created().length;
		let release: (() => void) | undefined;
		const holding = h.agentTabsLock.request("agentTabs", () => new Promise<void>((resolve) => (release = resolve)));
		const opening = h.run({ verb: "new", url: "https://next.example.test/b" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		await Promise.race([h.handler.stop(SESSION), new Promise((resolve) => setTimeout(resolve, 20))]);
		expect(await opening).toEqual({ ok: false, error: STOPPED });
		release?.();
		await holding;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.created()).toHaveLength(before);
	});

	it("saves no site that the person allows after the request was canceled", async () => {
		const controller = new AbortController();
		const options = { sites: "ask" as const, approval: "allow" as const, signal: controller.signal, onApproval: () => controller.abort() };
		const h = harness(options);
		expect((await h.run({ verb: "snapshot" })).ok).toBe(false);
		expect(h.fake.session.has(`pwExtSites:${SESSION}`)).toBe(false);
	});

	it("opens no tab when Stop comes while the site popup is open", async () => {
		const options = { sites: "ask" as const, record: false, approval: "allow" as const, onApproval: () => undefined as void };
		const h = harness(options);
		options.onApproval = () => void h.handler.stop(SESSION);
		expect(await h.run({ verb: "new", url: "https://next.example.test/" })).toEqual({ ok: false, error: STOPPED });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.created()).toEqual([]);
	});

	it("starts no new page work in a verb that Stop ended", async () => {
		let releaseRead: (() => void) | undefined;
		const h = harness({
			sites: "ask",
			approval: "allow",
			pageResult: { tree: "t", text: "x" },
			mainResult: (action) =>
				(action as { kind: string }).kind === "read"
					? new Promise((resolve) => {
							releaseRead = () => resolve({ dialogs: [] });
						})
					: { dialogs: [] },
		});
		const running = h.run({ verb: "snapshot" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		await h.handler.stop(SESSION);
		expect(await running).toEqual({ ok: false, error: STOPPED });
		releaseRead?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.executed().filter((call) => (call as { func?: { name?: string } }).func?.name === "pwExtPageAction")).toEqual([]);
	});

	it("settles a verb that the relay canceled earlier as soon as Stop comes", async () => {
		const relay = new AbortController();
		const h = harness({ sites: "ask", approval: "allow", signal: relay.signal, pageResult: new Promise(() => {}) });
		const running = h.run({ verb: "snapshot" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		relay.abort();
		await h.handler.stop(SESSION);
		expect(await running).toEqual({ ok: false, error: STOPPED });
	});

	it("captures no screenshot when Stop comes while the tab comes forward", async () => {
		const h = harness({ sites: "ask", approval: "allow" });
		const update = h.fake.raw.tabs.update;
		let stopping: Promise<void> | undefined;
		update.mockImplementationOnce(async () => {
			stopping = h.handler.stop(SESSION);
			return undefined as never;
		});
		expect(await h.run({ verb: "screenshot" })).toEqual({ ok: false, error: STOPPED });
		await stopping;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.fake.raw.tabs.captureVisibleTab).not.toHaveBeenCalled();
	});

	it("runs nothing for a verb whose first Stop check was still pending when Stop came", async () => {
		const h = harness({ sites: "ask", record: false, approval: "allow" });
		const get = h.fake.raw.storage.session.get;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		get.mockImplementationOnce(async (keys?: string | string[] | null) => {
			await gate;
			return {} as never;
		});
		const opening = h.run({ verb: "new", url: "https://next.example.test/" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await h.handler.stop(SESSION);
		release?.();
		expect(await opening).toEqual({ ok: false, error: STOPPED });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.created()).toEqual([]);
	});

	it("returns the Stop error when Stop comes during the final secret read", async () => {
		const h = harness({ sites: "ask", approval: "allow", pageResult: { text: "page text" } });
		await h.run({ verb: "selection" });
		const get = h.fake.raw.storage.session.get;
		const original = get.getMockImplementation();
		let stopping: Promise<void> | undefined;
		get.mockImplementation(async (keys?: string | string[] | null) => {
			if (keys === `pwExtSecrets:${SESSION}` && !stopping) stopping = h.handler.stop(SESSION);
			return (original as (k?: unknown) => Promise<Record<string, unknown>>)(keys);
		});
		expect(await h.run({ verb: "selection" })).toEqual({ ok: false, error: STOPPED });
		await stopping;
	});

	it("stops the session that owns the tab, and nothing for a user tab", async () => {
		const h = harness({ sites: "ask" });
		await h.handler.stopTab(21);
		expect((await h.run({ verb: "tabs" })).ok).toBe(true);
		await h.handler.stopTab(7);
		expect(await h.run({ verb: "tabs" })).toEqual({ ok: false, error: STOPPED });
	});
});

describe("pw --ext agent banner", () => {
	const bannerCalls = (h: ReturnType<typeof harness>) =>
		h.executed().filter((call) => (call as { func?: { name?: string } }).func?.name === "pwExtBanner");

	it("shows the banner in the isolated world with the shim, and hides it with the shim", async () => {
		const h = harness();
		h.fake.fireUpdated(7, { status: "loading" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		(h.fake.tabs.get(7) as FakeTab).groupId = -1;
		h.fake.fireUpdated(7, { groupId: -1 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(bannerCalls(h).map((call) => [call.world, call.args])).toEqual([
			[undefined, [true]],
			[undefined, [false]],
		]);
	});
});
