import type { AgentTabsStorage } from "./agent-tabs";

type WindowTab = { id?: number };

export type AgentWindowApi = {
	windows: {
		create(props: { url: string; focused: boolean; incognito: false }): Promise<{ id?: number; tabs?: WindowTab[] }>;
		get(windowId: number): Promise<{ id?: number; incognito?: boolean }>;
	};
	tabs: {
		query(query: { windowId: number }): Promise<WindowTab[]>;
		update(tabId: number, props: { url: string }): Promise<unknown>;
	};
};

const BLANK_URL = "about:blank";
const windowKey = (sessionId: string) => `agentWindow:${sessionId}`;

/** One normal browser window per ext session. It opens blank, so no site loads until navigate runs. */
export function createAgentWindows({
	browserApi: api,
	storage,
}: {
	browserApi: AgentWindowApi;
	storage: Pick<AgentTabsStorage, "session">;
}) {
	const opening = new Map<string, Promise<number>>();

	async function live(sessionId: string): Promise<number | undefined> {
		const stored = (await storage.session.get(windowKey(sessionId)))[windowKey(sessionId)];
		if (typeof stored !== "number") return undefined;
		const window = await api.windows.get(stored).catch(() => undefined);
		return window && !window.incognito ? stored : undefined;
	}

	async function create(sessionId: string): Promise<number> {
		const reused = await live(sessionId);
		if (reused !== undefined) return reused;
		const window = await api.windows.create({ url: BLANK_URL, focused: false, incognito: false });
		if (window.id === undefined) throw new Error("The browser opened no window.");
		await storage.session.set({ [windowKey(sessionId)]: window.id });
		return window.id;
	}

	function openAgentWindow(sessionId: string): Promise<number> {
		let pending = opening.get(sessionId);
		if (!pending) {
			pending = create(sessionId);
			opening.set(sessionId, pending);
			void pending.then(
				() => opening.delete(sessionId),
				() => opening.delete(sessionId),
			);
		}
		return pending;
	}

	return {
		openAgentWindow,

		async navigate(sessionId: string, url: string): Promise<void> {
			const windowId = await openAgentWindow(sessionId);
			const [tab] = await api.tabs.query({ windowId });
			if (tab?.id === undefined) throw new Error("The agent window has no tab.");
			await api.tabs.update(tab.id, { url });
		},

		forget(sessionId: string): Promise<void> {
			return storage.session.remove(windowKey(sessionId));
		},
	};
}

export type AgentWindows = ReturnType<typeof createAgentWindows>;
