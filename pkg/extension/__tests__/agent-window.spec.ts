import { describe, expect, it } from "bun:test";
import { type AgentWindowApi, createAgentWindows } from "@/lib/background/agent-window";

function memoryStorage() {
	const data: Record<string, unknown> = {};
	return {
		data,
		session: {
			get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
			set: async (items: Record<string, unknown>) => void Object.assign(data, items),
			remove: async (key: string) => void delete data[key],
		},
	};
}

function fakeBrowser() {
	const windows = new Map<number, { incognito: boolean; tabs: { id: number; url: string }[] }>();
	let next = 10;
	const created: { url?: string; incognito?: boolean; focused?: boolean }[] = [];
	const updated: { tabId: number; url: string }[] = [];
	const api: AgentWindowApi = {
		windows: {
			create: async (props) => {
				created.push(props);
				const id = next++;
				const tab = { id: id * 100, url: props.url };
				windows.set(id, { incognito: false, tabs: [tab] });
				return { id, tabs: [tab] };
			},
			get: async (id) => {
				const found = windows.get(id);
				if (!found) throw new Error("No window");
				return { id, incognito: found.incognito };
			},
		},
		tabs: {
			query: async ({ windowId }) => windows.get(windowId)?.tabs ?? [],
			update: async (tabId, props) => {
				updated.push({ tabId, url: props.url });
				return {};
			},
		},
	};
	return { api, windows, created, updated };
}

describe("openAgentWindow", () => {
	it("opens one blank unfocused window and reuses it for the same session", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		const first = await agent.openAgentWindow("s1");
		expect(await agent.openAgentWindow("s1")).toBe(first);
		expect(browser.created).toEqual([{ url: "about:blank", focused: false, incognito: false }]);
	});

	it("opens one window when two calls race", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		const [a, b] = await Promise.all([agent.openAgentWindow("s1"), agent.openAgentWindow("s1")]);
		expect(a).toBe(b);
		expect(browser.created).toHaveLength(1);
	});

	it("gives each session its own window", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		expect(await agent.openAgentWindow("s1")).not.toBe(await agent.openAgentWindow("s2"));
	});

	it("opens a new window after the person closes the old one", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		const first = await agent.openAgentWindow("s1");
		browser.windows.delete(first);
		const second = await agent.openAgentWindow("s1");
		expect(second).not.toBe(first);
	});

	it("does not reuse a private window", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		const first = await agent.openAgentWindow("s1");
		const held = browser.windows.get(first);
		if (held) held.incognito = true;
		expect(await agent.openAgentWindow("s1")).not.toBe(first);
	});

	it("forgets the window of a closed session", async () => {
		const browser = fakeBrowser();
		const storage = memoryStorage();
		const agent = createAgentWindows({ browserApi: browser.api, storage });
		await agent.openAgentWindow("s1");
		await agent.forget("s1");
		expect(Object.keys(storage.data)).toEqual([]);
	});
});

describe("navigate", () => {
	it("loads the url in the first tab of the session window", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		const windowId = await agent.openAgentWindow("s1");
		await agent.navigate("s1", "https://example.com/a");
		expect(browser.updated).toEqual([{ tabId: windowId * 100, url: "https://example.com/a" }]);
	});

	it("fails when the window has no tab", async () => {
		const browser = fakeBrowser();
		const agent = createAgentWindows({ browserApi: browser.api, storage: memoryStorage() });
		const windowId = await agent.openAgentWindow("s1");
		const held = browser.windows.get(windowId);
		if (held) held.tabs = [];
		await expect(agent.navigate("s1", "https://example.com/")).rejects.toThrow("no tab");
	});
});
