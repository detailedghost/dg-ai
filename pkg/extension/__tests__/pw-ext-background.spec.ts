import { describe, expect, it, mock } from "bun:test";
import type { PwExtRequest } from "@dg/common";
import {
	createPwExtHandler,
	type PwExtBrowserApi,
} from "@/lib/background/pw-ext";

type Tab = {
	incognito?: boolean;
	id: number;
	windowId: number;
	url: string;
	title: string;
	active: boolean;
};

const WEB_TAB: Tab = {
	id: 7,
	windowId: 3,
	url: "https://app.example.test/home?token=zzzzzzzzzzzzzzzz",
	title: "Home",
	active: true,
};

function harness(
	options: {
		tabs?: Tab[];
		pageResult?: unknown;
		mainResult?: (action: unknown) => unknown;
		asset?: Blob;
		chromium?: boolean;
		capture?: string;
		duringCapture?: Partial<Tab>;
		signal?: AbortSignal;
		switchBackDuringCapture?: boolean;
	} = {},
) {
	let tabs = options.tabs ?? [WEB_TAB];
	const executed: unknown[] = [];
	const fetched: string[] = [];
	const deleted: string[] = [];
	const created: unknown[] = [];
	const activated: Array<(info: { tabId: number; windowId: number }) => void> = [];
	const updated: Array<(tabId: number) => void> = [];
	const api = {
		windows: {
			getLastFocused: mock(async () => ({ id: 3, type: "normal" })),
		},
		tabs: {
			query: mock(async (query: { active?: boolean; windowId?: number }) =>
				tabs.filter(
					(tab) =>
						(query.active === undefined || tab.active === query.active) &&
						(query.windowId === undefined || tab.windowId === query.windowId),
				),
			),
			onActivated: {
				addListener: (fn: (info: { tabId: number; windowId: number }) => void) =>
					activated.push(fn),
				removeListener: () => {},
			},
			onUpdated: {
				addListener: (fn: (tabId: number) => void) => updated.push(fn),
				removeListener: () => {},
			},
			onRemoved: {
				addListener: () => {},
				removeListener: () => {},
			},
			get: mock(async (id: number) => {
				const tab = tabs.find((candidate) => candidate.id === id);
				if (!tab) throw new Error("No tab");
				return tab;
			}),
			create: mock(async (props: unknown) => {
				created.push(props);
				return { id: 99, windowId: 3, url: (props as { url: string }).url };
			}),
			captureVisibleTab: mock(async () => {
				if (options.switchBackDuringCapture) {
					for (const fn of activated) fn({ tabId: 8, windowId: 3 });
					for (const fn of activated) fn({ tabId: 7, windowId: 3 });
				}
				if (options.duringCapture)
					tabs = tabs.map((tab) =>
						tab.id === WEB_TAB.id ? { ...tab, ...options.duringCapture } : tab,
					);
				return options.capture ?? "data:image/jpeg;base64,AAAA";
			}),
		},
		scripting: {
			executeScript: mock(
				async (details: { args: unknown[]; world?: string }) => {
					const first = details.args[0] as { kind?: string } | undefined;
					executed.push(details);
					if (details.world === "MAIN")
						return [{ frameId: 0, result: options.mainResult?.(first) }];
					return [{ frameId: 0, result: options.pageResult }];
				},
			),
		},
	} as unknown as PwExtBrowserApi;
	const handler = createPwExtHandler({
		browserApi: api,
		isChromium: () => options.chromium ?? true,
	});
	return {
		runWith:
			(context: { fetchAsset(id: string): Promise<Blob> }) =>
			(request: PwExtRequest) =>
				handler(request, options.signal, {
					deleteAsset: async (assetId: string) => {
						deleted.push(assetId);
					},
					...context,
				}),
		run: (request: PwExtRequest) =>
			handler(request, options.signal, {
					fetchAsset: async (assetId: string) => {
						fetched.push(assetId);
						if (!options.asset) throw new Error("no asset");
						return options.asset;
					},
					deleteAsset: async (assetId: string) => {
						deleted.push(assetId);
					},
				},
			),
		api,
		executed,
		fetched,
		deleted,
		created,
	};
}

describe("pw --ext background handler", () => {
	it("discards a screenshot when the window switched tabs during capture", async () => {
		const h = harness({ duringCapture: { active: false } });
		const answer = await h.run({ verb: "screenshot" });
		expect(answer).toEqual({
			ok: false,
			error: expect.stringContaining("changed"),
		});
	});

	it("discards a screenshot when the window switched away and back during capture", async () => {
		const h = harness({ switchBackDuringCapture: true });
		expect(await h.run({ verb: "screenshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("changed"),
		});
	});

	it("runs a click with no approval step and binds it to the page URL", async () => {
		const h = harness({ pageResult: { detail: "clicked" } });
		expect(await h.run({ verb: "click", target: "e1" })).toMatchObject({ ok: true });
		expect((h.executed[0] as { args: unknown[] }).args).toEqual([
			{ kind: "click", target: "e1" },
			WEB_TAB.url,
		]);
	});

	it("runs a fill and keeps the typed value out of the result", async () => {
		const h = harness({ pageResult: { detail: 'filled textbox "Search"' } });
		const answer = await h.run({ verb: "fill", target: "e2", value: "cats" });
		expect(answer).toMatchObject({ ok: true });
		if (answer.ok) expect(answer.data.text).not.toContain("cats");
		expect((h.executed[0] as { args: unknown[] }).args[0]).toEqual({
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
		expect(h.executed).toEqual([]);
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
		const answer = await h.run({ verb: "snapshot" });
		expect(answer).toEqual({
			ok: false,
			error: expect.stringContaining("browser settings"),
		});
		expect(h.executed).toEqual([]);
	});

	it("blocks a click on a browser page without running the page script", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, url: "chrome://settings" }] });
		expect(await h.run({ verb: "click", target: "e1" })).toEqual({
			ok: false,
			error: expect.stringContaining("browser settings"),
		});
		expect(h.executed).toEqual([]);
	});

	it("blocks a fill on the signed-in Proton Mail tab without running the page script", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox" }] });
		expect(await h.run({ verb: "fill", target: "e1", value: "x" })).toEqual({
			ok: false,
			error: expect.stringContaining("Proton Mail"),
		});
		expect(h.executed).toEqual([]);
	});

	it("blocks the signed-in Proton Mail tab", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox", title: "Secret subject" }],
		});
		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("Proton Mail"),
		});
		const listing = await h.run({ verb: "current" });
		expect(listing.ok).toBe(true);
		if (listing.ok) {
			expect(listing.data.text).toContain("(protected mailbox)");
			expect(listing.data.text).not.toContain("Secret subject");
		}
	});

	it("never acts on or lists private windows", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, incognito: true }] });
		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("non-private"),
		});
		const mixed = harness({
			tabs: [
				WEB_TAB,
				{ ...WEB_TAB, id: 9, windowId: 5, active: false, incognito: true, title: "Private" },
			],
		});
		const listing = await mixed.run({ verb: "current" });
		expect(listing.ok && listing.data.text).not.toContain("Private");
	});

	it("refuses a non-Chromium browser", async () => {
		const h = harness({ chromium: false });
		expect(await h.run({ verb: "current" })).toEqual({
			ok: false,
			error: expect.stringContaining("Chromium"),
		});
	});

	it("lists open tabs without exposing browser page URLs", async () => {
		const h = harness({
			tabs: [
				WEB_TAB,
				{ id: 8, windowId: 3, url: "chrome://settings", title: "Settings", active: false },
			],
		});
		const answer = await h.run({ verb: "current" });
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.data.text).toContain("- Page URL: https://app.example.test/home?token=[redacted]");
		expect(answer.data.text).toContain("[active] 7: Home");
		expect(answer.data.text).toContain("- 8: (browser page)");
		expect(answer.data.text).not.toContain("chrome://settings");
	});

	it("opens a new tab", async () => {
		const h = harness();
		const answer = await h.run({ verb: "open", url: "https://example.test/" });
		expect(h.created).toEqual([
			{ url: "https://example.test/", windowId: 3, active: true },
		]);
		expect(answer).toMatchObject({ ok: true });
	});

	it("returns a screenshot of the active tab", async () => {
		const h = harness();
		const answer = await h.run({ verb: "screenshot" });
		expect(answer).toMatchObject({
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
		expect((h.executed[0] as { args: unknown[] }).args).toEqual([
			{
				kind: "upload",
				target: "#file",
				base64: Buffer.from("hello").toString("base64"),
				fileName: "demo.webm",
				fileType: "video/webm",
			},
			WEB_TAB.url,
		]);
		expect(answer).toMatchObject({ ok: true });
	});

	it("refuses an upload whose staged bytes do not match the declared size", async () => {
		const h = harness({ asset: new Blob(["longer than five"]) });
		expect(await h.run(UPLOAD)).toEqual({
			ok: false,
			error: expect.stringContaining("size"),
		});
		expect(h.executed).toEqual([]);
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
		expect(h.executed).toEqual([]);
	});

	it("passes the tab URL to the console hook and caps its entries", async () => {
		const h = harness({
			pageResult: { started: false, entries: [] },
			mainResult: () => ({
				entries: Array.from({ length: 80 }, () => `[warning] ${"w".repeat(2000)}`),
			}),
		});
		const answer = await h.run({ verb: "console" });
		const main = h.executed.find(
			(call) => (call as { world?: string }).world === "MAIN",
		) as { args: unknown[] };
		expect(main.args).toEqual([WEB_TAB.url]);
		expect(answer.ok).toBe(true);
		if (answer.ok) {
			const lines = answer.data.text.split("\n").filter((line) => line.startsWith("[warning]"));
			expect(lines).toHaveLength(50);
			expect(lines.every((line) => line.length <= 520)).toBe(true);
		}
	});
});
