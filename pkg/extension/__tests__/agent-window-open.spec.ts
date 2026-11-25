import { describe, expect, it } from "bun:test";
import type { PwExtRequest } from "@dg/common";
import { createAgentTabs } from "@/lib/background/agent-tabs";
import { createAgentWindows } from "@/lib/background/agent-window";
import { createPwExtHandler } from "@/lib/background/pw-ext";
import { createSessionControl } from "@/lib/background/session-control";
import { createSiteAllow } from "@/lib/background/site-allow-prompt";
import { createFakeBrowser, createLock, tabOf, windowOf } from "./utils/fake-browser";

const SESSION = "session-1";
const USER_WINDOW = 3;
const SITE = "https://app.example.test/home";

async function harness(options: { answer?: "allow" | "deny"; allowed?: boolean } = {}) {
	const fake = createFakeBrowser({
		windows: [windowOf({ id: USER_WINDOW })],
		lastFocusedWindowId: USER_WINDOW,
		tabs: [tabOf({ id: 21, windowId: USER_WINDOW, url: "https://user.example.test/" })],
	});
	const storage = fake.api.storage;
	const control = createSessionControl({ storage });
	if (options.allowed) await control.allow(SESSION, "https://example.test");
	const lock = createLock();
	const agentTabs = createAgentTabs({ browserApi: fake.api, storage, lock });
	const agentWindows = createAgentWindows({ browserApi: fake.api as never, storage });
	const prompts: string[] = [];
	const siteAllow = createSiteAllow({
		control,
		storage,
		pageUrl: (path) => `chrome-extension://dg${path}`,
		navigate: agentWindows.navigate,
		newId: () => "prompt-1",
		windows: {
			open: async (url) => {
				prompts.push(url);
				queueMicrotask(() => siteAllow.answer("prompt-1", (options.answer ?? "allow") === "allow"));
				return 900;
			},
			close: async () => undefined,
			onRemoved: () => undefined,
		},
	});
	const handler = createPwExtHandler({
		browserApi: fake.api,
		agentTabs,
		lock,
		control,
		siteAllow,
		agentWindows,
	});
	const run = (request: PwExtRequest) =>
		handler({
			request,
			timeoutMs: 60_000,
			signal: new AbortController().signal,
			progress: () => undefined,
			context: {
				sessionId: SESSION,
				agentIdentity: "agent",
				fetchAsset: async () => new Blob(),
				deleteAsset: async () => undefined,
				storeCredential: async () => "",
			},
		} as never);
	return { run, fake, prompts };
}

const agentWindowTabs = (h: Awaited<ReturnType<typeof harness>>) =>
	[...h.fake.tabs.values()].filter((tab) => tab.windowId !== USER_WINDOW);

describe.each<PwExtRequest["verb"]>(["open", "new"])("%s in the agent window", (verb) => {
	const request = { verb, url: SITE } as PwExtRequest;

	it("loads an allowed site in the one unfocused agent window and groups its tab", async () => {
		const h = await harness({ allowed: true });
		expect(await h.run(request)).toMatchObject({ ok: true });
		expect(h.prompts).toEqual([]);
		expect(h.fake.raw.windows.create).toHaveBeenCalledTimes(1);
		expect(h.fake.raw.windows.create.mock.calls[0]?.[0]).toMatchObject({ focused: false, incognito: false });
		const tabs = agentWindowTabs(h);
		expect(tabs.map((tab) => tab.url)).toEqual([SITE]);
		const record = h.fake.record(SESSION);
		expect(tabs[0]?.groupId).toBe(record?.groupId as number);
		expect(h.fake.groups.get(record?.groupId as number)?.windowId).toBe(tabs[0]?.windowId as number);
		expect(record?.selectedTabId).toBe(tabs[0]?.id as number);
		expect([...h.fake.tabs.values()].filter((tab) => tab.windowId === USER_WINDOW)).toHaveLength(1);
	});

	it("asks first for a new site, then loads it after Allow", async () => {
		const h = await harness({ answer: "allow" });
		expect(await h.run(request)).toMatchObject({ ok: true });
		expect(h.prompts).toHaveLength(1);
		expect(agentWindowTabs(h).map((tab) => tab.url)).toEqual([SITE]);
	});

	it("loads nothing and opens no agent window after Deny", async () => {
		const h = await harness({ answer: "deny" });
		expect(await h.run(request)).toMatchObject({ ok: false });
		expect(h.prompts).toHaveLength(1);
		expect(h.fake.raw.windows.create).not.toHaveBeenCalled();
		expect(h.fake.raw.tabs.update).not.toHaveBeenCalled();
		expect(h.fake.raw.tabs.create).not.toHaveBeenCalled();
		expect(h.fake.record(SESSION)).toBeUndefined();
	});

	it("opens a later tab in the same agent window and group", async () => {
		const h = await harness({ allowed: true });
		await h.run(request);
		expect(await h.run({ verb: "new", url: "https://other.example.test/" })).toMatchObject({ ok: true });
		expect(h.fake.raw.windows.create).toHaveBeenCalledTimes(1);
		const tabs = agentWindowTabs(h);
		expect(tabs).toHaveLength(2);
		expect(new Set(tabs.map((tab) => tab.windowId)).size).toBe(1);
		expect(new Set(tabs.map((tab) => tab.groupId)).size).toBe(1);
	});

	it("refuses the Proton Mail tab without opening a window", async () => {
		const h = await harness({ allowed: true });
		expect(await h.run({ verb, url: "https://mail.proton.me/u/0/inbox" } as PwExtRequest)).toMatchObject({ ok: false });
		expect(h.fake.raw.windows.create).not.toHaveBeenCalled();
	});
});
