import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PageRequest } from "@dg/common/pw-ext-verbs/page";
import { createPageVerbHandler, evaluate } from "@/lib/background/pw-verbs/page";

type Tab = { id: number; windowId?: number; url?: string; incognito?: boolean; discarded?: boolean };

const CONTEXT = { sessionId: "s1" };
const APP: Tab = { id: 7, windowId: 3, url: "https://app.example.test/home" };

function setup({
	tabs = [APP],
	owned = [7],
	selected = 7,
	sites = ["https://example.test"],
	frame = { result: { ok: true, text: "42" } } as { result?: unknown },
	incognitoWindow = false,
	selectError,
}: {
	tabs?: Tab[];
	owned?: number[];
	selected?: number | null;
	sites?: string[];
	frame?: { result?: unknown };
	incognitoWindow?: boolean;
	selectError?: string;
} = {}) {
	const executed: { args: unknown[]; world?: string; tabId: number }[] = [];
	const resized: { windowId: number; props: unknown }[] = [];
	const picked: { sessionId: string; tabId: number }[] = [];
	const handler = createPageVerbHandler({
		browserApi: {
			tabs: {
				get: async (id: number) => {
					const found = tabs.find((tab) => tab.id === id);
					if (!found) throw new Error("No tab");
					return found;
				},
			},
			windows: {
				get: async () => ({ incognito: incognitoWindow }),
				update: async (windowId: number, props: unknown) => {
					resized.push({ windowId, props });
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
			selected: async () => (selected === null ? undefined : { tabId: selected }),
			select: async (args: { sessionId: string; tabId: number }) => {
				if (selectError) throw new Error(selectError);
				picked.push(args);
			},
		} as never,
		control: { allowed: async (_session: string, site: string) => sites.includes(site) } as never,
	});
	return { handler, executed, resized, picked };
}

const run: PageRequest = { verb: "eval", expression: "6 * 7" };
const size: PageRequest = { verb: "resize", width: 900, height: 700 };

describe("page verb handler: eval", () => {
	it("evaluates in the main world of the selected tab and returns the text", async () => {
		const { handler, executed } = setup();
		const result = await handler(run, CONTEXT);
		expect(result).toEqual({ ok: true, data: { text: "### Result\n42" } });
		expect(executed).toEqual([{ tabId: 7, world: "MAIN", args: ["6 * 7", APP.url] }]);
	});

	it("never echoes the expression", async () => {
		const { handler } = setup();
		const result = await handler({ verb: "eval", expression: "localStorage.token // hunter2-secret" }, CONTEXT);
		expect(JSON.stringify(result)).not.toContain("hunter2-secret");
	});

	it("never echoes the expression when the page fails", async () => {
		const { handler } = setup({ frame: { result: { ok: false, error: "The page refused the script (TypeError)." } } });
		const result = await handler({ verb: "eval", expression: "hunter2-secret()" }, CONTEXT);
		expect(result).toEqual({ ok: false, error: "The page refused the script (TypeError)." });
	});

	it("refuses a tab outside the agent tab group", async () => {
		const { handler, executed } = setup({ tabs: [APP, { id: 9, windowId: 3, url: "https://app.example.test/" }] });
		const result = await handler({ ...run, tabId: 9 }, CONTEXT);
		expect(result).toEqual({
			ok: false,
			error: "pw --ext: tab 9 is not in this agent's tab group; run pw --ext tabs to list them.",
		});
		expect(executed).toEqual([]);
	});

	it("refuses a site outside the session allowlist without running", async () => {
		const { handler, executed } = setup({ sites: ["https://other.test"] });
		expect(await handler(run, CONTEXT)).toEqual({
			ok: false,
			error: "pw --ext: example.test is not on this session's allowed sites; eval did not run.",
		});
		expect(executed).toEqual([]);
	});

	it("reports when the agent has no tab", async () => {
		const { handler } = setup({ selected: null });
		expect(await handler(run, CONTEXT)).toEqual({
			ok: false,
			error: "This agent has no tab yet. Run pw --ext new <url> first.",
		});
	});

	it("reports an unreadable page reply", async () => {
		const { handler } = setup({ frame: { result: "junk" } });
		const result = await handler(run, CONTEXT);
		expect(result.ok).toBe(false);
	});

	it.each([
		["a private tab", { ...APP, incognito: true }],
		["a browser page", { ...APP, url: "chrome://settings" }],
		["a store page", { ...APP, url: "https://chromewebstore.google.com/detail/x" }],
		["a mailbox tab", { ...APP, url: "https://mail.proton.me/u/0/inbox" }],
		["a discarded tab", { ...APP, discarded: true }],
	])("refuses %s", async (_name, tab) => {
		const { handler, executed } = setup({
			tabs: [tab],
			sites: ["chrome://settings", "https://proton.me", "https://google.com", "https://example.test"],
		});
		expect((await handler(run, CONTEXT)).ok).toBe(false);
		expect(executed).toEqual([]);
	});

	it("rejects an invalid request before touching a tab", async () => {
		const { handler, executed } = setup();
		expect((await handler({ verb: "eval" }, CONTEXT)).ok).toBe(false);
		expect(executed).toEqual([]);
	});
});

describe("page verb handler: tab-select", () => {
	it("selects an owned tab", async () => {
		const { handler, picked } = setup({ owned: [7, 9] });
		const result = await handler({ verb: "tab-select", tabId: 9 }, CONTEXT);
		expect(result).toEqual({ ok: true, data: { text: "### Result\nSelected tab 9" } });
		expect(picked).toEqual([{ sessionId: "s1", tabId: 9 }]);
	});

	it("refuses a tab outside the agent tab group", async () => {
		const { handler, picked } = setup({ owned: [7] });
		const result = await handler({ verb: "tab-select", tabId: 9 }, CONTEXT);
		expect(result).toEqual({
			ok: false,
			error: "pw --ext: tab 9 is not in this agent's tab group; run pw --ext tabs to list them.",
		});
		expect(picked).toEqual([]);
	});

	it("reports a refusal from the tab group", async () => {
		const { handler } = setup({ selectError: "That tab left the group." });
		expect(await handler({ verb: "tab-select", tabId: 7 }, CONTEXT)).toEqual({
			ok: false,
			error: "pw --ext tab-select failed on tab 7: That tab left the group.",
		});
	});
});

describe("page verb handler: resize", () => {
	it("resizes the window of the selected agent tab", async () => {
		const { handler, resized } = setup();
		const result = await handler(size, CONTEXT);
		expect(result).toEqual({ ok: true, data: { text: "### Result\nResized the agent window to 900x700" } });
		expect(resized).toEqual([{ windowId: 3, props: { width: 900, height: 700, state: "normal" } }]);
	});

	it("refuses a tab outside the agent tab group", async () => {
		const { handler, resized } = setup({ tabs: [APP, { id: 9, windowId: 5, url: "https://app.example.test/" }] });
		const result = await handler({ ...size, tabId: 9 }, CONTEXT);
		expect(result).toEqual({
			ok: false,
			error: "pw --ext: tab 9 is not in this agent's tab group; run pw --ext tabs to list them.",
		});
		expect(resized).toEqual([]);
	});

	it("refuses a private window", async () => {
		const { handler, resized } = setup({ incognitoWindow: true });
		expect((await handler(size, CONTEXT)).ok).toBe(false);
		expect(resized).toEqual([]);
	});

	it("reports when the agent has no tab", async () => {
		const { handler } = setup({ selected: null });
		expect((await handler(size, CONTEXT)).ok).toBe(false);
	});
});

describe("evaluate", () => {
	const PAGE = "https://app.example.test/";
	const real = Object.getOwnPropertyDescriptor(globalThis, "location");
	beforeEach(() => void Object.defineProperty(globalThis, "location", { value: { href: PAGE }, configurable: true }));
	afterEach(() => (real ? Object.defineProperty(globalThis, "location", real) : void delete (globalThis as { location?: unknown }).location));

	it("does not run the script when the page moved to another url", async () => {
		const outcome = await evaluate("globalThis.ran = true", "https://other.example.test/");
		expect(outcome).toEqual({ ok: false, error: "The page changed before the script ran; nothing ran." });
		expect((globalThis as { ran?: boolean }).ran).toBeUndefined();
	});

	it("returns the JSON of a value", async () => {
		expect(await evaluate("({ a: [1, 2] })", PAGE)).toEqual({ ok: true, text: '{"a":[1,2]}' });
	});

	it("awaits a promise", async () => {
		expect(await evaluate("Promise.resolve('x')", PAGE)).toEqual({ ok: true, text: '"x"' });
	});

	it("reports undefined as text", async () => {
		expect(await evaluate("undefined", PAGE)).toEqual({ ok: true, text: "undefined" });
	});

	it("reports only the error name when the script throws", async () => {
		expect(await evaluate("(() => { throw new TypeError('hunter2-secret'); })()", PAGE)).toEqual({
			ok: false,
			error: "The page refused the script (TypeError).",
		});
	});
});
