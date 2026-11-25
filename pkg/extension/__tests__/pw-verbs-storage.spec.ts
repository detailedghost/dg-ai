import { describe, expect, it } from "bun:test";
import type { StorageRequest } from "@dg/common/pw-ext-verbs/storage";
import {
	createStorageVerbHandler,
	writeStorage,
} from "@/lib/background/pw-verbs/storage";

type Frame = { result?: unknown };
type Tab = { id: number; url?: string; incognito?: boolean; discarded?: boolean; groupId?: number };

const CONTEXT = { sessionId: "s1" };
const APP: Tab = { id: 7, url: "https://app.example.test/home", groupId: 10 };

function setup({
	tabs = [APP],
	owned = [7],
	selected = 7,
	sites = ["https://example.test"],
	frame = { result: { ok: true, removed: 0 } },
}: {
	tabs?: Tab[];
	owned?: number[];
	selected?: number | undefined;
	sites?: string[];
	frame?: Frame;
} = {}) {
	const executed: { args: unknown[]; world?: string; tabId: number }[] = [];
	const handler = createStorageVerbHandler({
		browserApi: {
			tabs: {
				get: async (id: number) => {
					const found = tabs.find((tab) => tab.id === id);
					if (!found) throw new Error("No tab");
					return found;
				},
			},
			scripting: {
				executeScript: async (details: { args: unknown[]; world?: string; target: { tabId: number } }) => {
					executed.push({ args: details.args, world: details.world, tabId: details.target.tabId });
					return [frame];
				},
			},
		} as never,
		agentTabs: {
			owns: async ({ tabId }: { tabId: number }) => owned.includes(tabId),
			selected: async () => (selected === undefined ? undefined : { tabId: selected }),
		} as never,
		control: { allowed: async (_session: string, site: string) => sites.includes(site) } as never,
	});
	return { handler, executed };
}

const set: StorageRequest = { verb: "localstorage-set", key: "theme", value: "dark" };

describe("storage verb handler", () => {
	it("writes through the selected tab in the isolated world", async () => {
		const { handler, executed } = setup();
		const result = await handler(set, CONTEXT);
		expect(result).toEqual({
			ok: true,
			data: { text: '### Result\nSet localStorage "theme" on https://app.example.test' },
		});
		expect(executed).toEqual([
			{ tabId: 7, world: "ISOLATED", args: ["local", "set", "theme", "dark", "https://app.example.test"] },
		]);
	});

	it("never echoes the written value", async () => {
		const { handler } = setup();
		const result = await handler({ ...set, value: "hunter2-secret" }, CONTEXT);
		expect(JSON.stringify(result)).not.toContain("hunter2-secret");
	});

	it("reports how many keys a clear removed", async () => {
		const { handler } = setup({ frame: { result: { ok: true, removed: 3 } } });
		const result = await handler({ verb: "sessionstorage-clear" }, CONTEXT);
		expect(result).toEqual({
			ok: true,
			data: { text: "### Result\nCleared 3 keys from sessionStorage on https://app.example.test" },
		});
	});

	it("refuses a tab outside the agent tab group", async () => {
		const { handler, executed } = setup({ tabs: [APP, { id: 9, url: "https://app.example.test/", groupId: -1 }] });
		const result = await handler({ ...set, tabId: 9 }, CONTEXT);
		expect(result).toEqual({
			ok: false,
			error: "pw --ext: tab 9 is not in this agent's tab group; run pw --ext tabs to list them.",
		});
		expect(executed).toEqual([]);
	});

	it.each(["localstorage-delete", "sessionstorage-clear"] as const)(
		"refuses %s on a tab outside the agent tab group",
		async (verb) => {
			const { handler, executed } = setup({ owned: [] });
			const request = verb === "localstorage-delete" ? { verb, key: "k", tabId: 7 } : { verb, tabId: 7 };
			const result = await handler(request, CONTEXT);
			expect(result.ok).toBe(false);
			expect(executed).toEqual([]);
		},
	);

	it("refuses a site outside the session allowlist without running", async () => {
		const { handler, executed } = setup({ sites: ["https://other.test"] });
		const result = await handler(set, CONTEXT);
		expect(result).toEqual({
			ok: false,
			error: "pw --ext: example.test is not on this session's allowed sites; storage was not changed.",
		});
		expect(executed).toEqual([]);
	});

	it("reports when the agent has no tab", async () => {
		const { handler } = setup({ selected: undefined });
		expect(await handler(set, CONTEXT)).toEqual({
			ok: false,
			error: "This agent has no tab yet. Run pw --ext new <url> first.",
		});
	});

	it.each([
		["a private tab", { ...APP, incognito: true }],
		["a browser page", { ...APP, url: "chrome://settings" }],
		["a store page", { ...APP, url: "https://chromewebstore.google.com/detail/x" }],
		["a mailbox tab", { ...APP, url: "https://mail.proton.me/u/0/inbox" }],
		["a discarded tab", { ...APP, discarded: true }],
	])("refuses %s", async (_name, tab) => {
		const { handler, executed } = setup({ tabs: [tab], sites: ["chrome://settings", "https://proton.me", "https://google.com", "https://example.test"] });
		const result = await handler(set, CONTEXT);
		expect(result.ok).toBe(false);
		expect(executed).toEqual([]);
	});

	it("rejects an invalid request before touching a tab", async () => {
		const { handler, executed } = setup();
		const result = await handler({ verb: "localstorage-set", key: "k" }, CONTEXT);
		expect(result.ok).toBe(false);
		expect(executed).toEqual([]);
	});

	it("reports a page error and an unreadable page reply", async () => {
		const failing = setup({ frame: { result: { ok: false, error: "The page moved to another origin; nothing was changed." } } });
		expect(await failing.handler(set, CONTEXT)).toEqual({
			ok: false,
			error: "The page moved to another origin; nothing was changed.",
		});
		const garbled = setup({ frame: { result: "boom" } });
		expect((await garbled.handler(set, CONTEXT)).ok).toBe(false);
	});
});

describe("writeStorage page function", () => {
	function fakeStorage(entries: Record<string, string> = {}) {
		const map = new Map(Object.entries(entries));
		return {
			map,
			get length() {
				return map.size;
			},
			setItem: (key: string, value: string) => void map.set(key, value),
			removeItem: (key: string) => void map.delete(key),
			clear: () => map.clear(),
		};
	}

	function withPage<T>(origin: string, local: ReturnType<typeof fakeStorage>, session: ReturnType<typeof fakeStorage>, run: () => T): T {
		const g = globalThis as Record<string, unknown>;
		const saved = { location: g.location, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
		Object.assign(g, { location: { origin }, localStorage: local, sessionStorage: session });
		try {
			return run();
		} finally {
			Object.assign(g, saved);
		}
	}

	it("sets, deletes and clears the chosen area only", () => {
		const local = fakeStorage({ a: "1", b: "2" });
		const session = fakeStorage({ s: "x" });
		const origin = "https://app.example.test";
		withPage(origin, local, session, () => {
			expect(writeStorage("local", "set", "c", "3", origin)).toEqual({ ok: true, removed: 0 });
			expect(writeStorage("local", "delete", "a", undefined, origin)).toEqual({ ok: true, removed: 1 });
			expect(writeStorage("local", "clear", undefined, undefined, origin)).toEqual({ ok: true, removed: 2 });
		});
		expect([...local.map]).toEqual([]);
		expect([...session.map]).toEqual([["s", "x"]]);
	});

	it("refuses when the page origin changed since the check", () => {
		const local = fakeStorage({ a: "1" });
		const result = withPage("https://evil.test", local, fakeStorage(), () =>
			writeStorage("local", "clear", undefined, undefined, "https://app.example.test"),
		);
		expect(result).toEqual({ ok: false, error: "The page moved to another origin; nothing was changed." });
		expect(local.map.size).toBe(1);
	});

	it("reports a storage failure by name", () => {
		const local = fakeStorage();
		local.setItem = () => {
			throw new DOMException("full", "QuotaExceededError");
		};
		const result = withPage("https://a.test", local, fakeStorage(), () =>
			writeStorage("local", "set", "k", "v", "https://a.test"),
		);
		expect(result).toEqual({ ok: false, error: "The page refused the write (QuotaExceededError)." });
	});
});
