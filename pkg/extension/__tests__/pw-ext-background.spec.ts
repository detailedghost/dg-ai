import { describe, expect, it, mock } from "bun:test";
import type { PwExtRequest } from "@dg/common";
import {
	createPwExtHandler,
	type PwExtApprovalPrompt,
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
	url: "https://app.example.test/home?token=abcdef1234567890",
	title: "Home",
	active: true,
};

function harness(
	options: {
		tabs?: Tab[];
		approve?: boolean;
		pageResult?: unknown;
		describeResult?: unknown;
		mainResult?: (action: unknown) => unknown;
		asset?: Blob;
		afterApproval?: Partial<Tab>;
		chromium?: boolean;
		capture?: string;
		duringCapture?: Partial<Tab>;
		signal?: AbortSignal;
		abortOnApprove?: AbortController;
		switchBackDuringCapture?: boolean;
		abortOnFinalGet?: AbortController;
	} = {},
) {
	let tabs = options.tabs ?? [WEB_TAB];
	const prompts: PwExtApprovalPrompt[] = [];
	const executed: unknown[] = [];
	const described: unknown[] = [];
	const fetched: string[] = [];
	const created: unknown[] = [];
	const activated: Array<(info: { tabId: number; windowId: number }) => void> = [];
	const updated: Array<(tabId: number) => void> = [];
	let gets = 0;
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
				gets++;
				if (gets === 1) options.abortOnFinalGet?.abort();
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
					if (details.world !== "MAIN" && first?.kind === "describe") {
						described.push(first);
						return [
							{
								frameId: 0,
								result: options.describeResult ?? {
									element: { tag: "button", role: "button", name: "Go", text: "Go" },
								},
							},
						];
					}
					executed.push(details);
					if (details.world === "MAIN")
						return [{ frameId: 0, result: options.mainResult?.(first) }];
					return [{ frameId: 0, result: options.pageResult }];
				},
			),
		},
	} as unknown as PwExtBrowserApi;
	const approve = mock(async (prompt: PwExtApprovalPrompt) => {
		prompts.push(prompt);
		options.abortOnApprove?.abort();
		if (options.afterApproval)
			tabs = tabs.map((tab) =>
				tab.id === WEB_TAB.id ? { ...tab, ...options.afterApproval } : tab,
			);
		return options.approve ?? true;
	});
	const handler = createPwExtHandler({
		browserApi: api,
		approve,
		isChromium: () => options.chromium ?? true,
	});
	return {
		run: (request: PwExtRequest) =>
			handler(
				request,
				60_000,
				options.abortOnApprove?.signal ??
					options.abortOnFinalGet?.signal ??
					options.signal,
				{
					fetchAsset: async (assetId: string) => {
						fetched.push(assetId);
						if (!options.asset) throw new Error("no asset");
						return options.asset;
					},
				},
			),
		api,
		prompts,
		executed,
		described,
		fetched,
		created,
	};
}

describe("pw --ext background handler", () => {
	it("binds the page action to the approved URL", async () => {
		const h = harness({ pageResult: { detail: "clicked" } });
		await h.run({ verb: "click", target: "e1" });
		expect((h.executed[0] as { args: unknown[] }).args).toEqual([
			{ kind: "click", target: "e1" },
			WEB_TAB.url,
		]);
	});

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

	it("does nothing when the request is canceled during the final tab check", async () => {
		const h = harness({ abortOnFinalGet: new AbortController() });
		expect(await h.run({ verb: "click", target: "e1" })).toEqual({
			ok: false,
			error: expect.stringContaining("canceled"),
		});
		expect(h.executed).toEqual([]);
	});

	it("shows the full fill value in the approval", async () => {
		const value = `${"a".repeat(250)}\nsecond line`;
		const h = harness({ pageResult: { detail: "filled" } });
		await h.run({ verb: "fill", target: "e2", value });
		expect(h.prompts[0]?.detail).toBe(
			`Fill e2\nElement: button "Go" <button>\nWith:\n${value}`,
		);
	});

	it("does nothing when the request is canceled during approval", async () => {
		const h = harness({ abortOnApprove: new AbortController() });
		const answer = await h.run({ verb: "click", target: "e1" });
		expect(answer).toEqual({
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

	it("asks once per read, naming the tab, then returns a redacted snapshot", async () => {
		const h = harness({
			pageResult: {
				tree: '- button "Go" [ref=e1]\n- text: ghp_abcdefghijklmnopqrstuvwxyz',
				text: "Contact me@example.test",
			},
		});
		const answer = await h.run({ verb: "snapshot" });
		expect(h.prompts).toEqual([
			{
				verb: "snapshot",
				write: false,
				tabTitle: "Home",
				tabUrl: "https://app.example.test/home?token=[redacted]",
			},
		]);
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.data.text).toContain("### Page");
		expect(answer.data.text).toContain('- button "Go" [ref=e1]');
		expect(answer.data.text).toContain("### Visible text");
		expect(answer.data.text).not.toContain("abcdef1234567890");
		expect(answer.data.text).not.toContain("ghp_abcdefghij");
		expect(answer.data.text).not.toContain("me@example.test");
	});

	it("marks write verbs and shows what they change", async () => {
		const h = harness({ pageResult: { detail: 'filled textbox "Search"' } });
		const answer = await h.run({ verb: "fill", target: "e2", value: "cats" });
		expect(h.prompts[0]).toMatchObject({
			verb: "fill",
			write: true,
			detail: 'Fill e2\nElement: button "Go" <button>\nWith:\ncats',
		});
		expect(answer).toMatchObject({ ok: true });
		if (answer.ok) expect(answer.data.text).not.toContain("cats");
	});

	it("does nothing when the human denies", async () => {
		const h = harness({ approve: false });
		const answer = await h.run({ verb: "click", target: "e1" });
		expect(answer).toEqual({
			ok: false,
			error: expect.stringContaining("denied"),
		});
		expect(h.executed).toEqual([]);
	});

	it("does nothing when the tab changed after approval", async () => {
		const h = harness({ afterApproval: { url: "https://other.example.test/" } });
		const answer = await h.run({ verb: "click", target: "e1" });
		expect(answer).toEqual({
			ok: false,
			error: expect.stringContaining("changed"),
		});
		expect(h.executed).toEqual([]);
	});

	it.each([
		"chrome://settings/passwords",
		"edge://settings",
		"brave://wallet",
		"about:blank",
		"chrome-extension://abcdefghijklmnop/options.html",
		"file:///home/me/notes.txt",
		"https://chromewebstore.google.com/detail/x",
	])("blocks %s without asking", async (url) => {
		const h = harness({ tabs: [{ ...WEB_TAB, url }] });
		const answer = await h.run({ verb: "snapshot" });
		expect(answer).toEqual({
			ok: false,
			error: expect.stringContaining("browser settings"),
		});
		expect(h.prompts).toEqual([]);
		expect(h.executed).toEqual([]);
	});

	it("blocks the signed-in Proton Mail tab without asking", async () => {
		const h = harness({
			tabs: [{ ...WEB_TAB, url: "https://mail.proton.me/u/0/inbox", title: "Secret subject" }],
		});
		expect(await h.run({ verb: "snapshot" })).toEqual({
			ok: false,
			error: expect.stringContaining("Proton Mail"),
		});
		expect(h.prompts).toEqual([]);
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
		expect(h.prompts).toEqual([]);
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
		expect(h.prompts).toEqual([]);
	});

	it("lists open tabs without exposing browser page URLs", async () => {
		const h = harness({
			tabs: [
				WEB_TAB,
				{ id: 8, windowId: 3, url: "chrome://settings", title: "Settings", active: false },
			],
		});
		const answer = await h.run({ verb: "current" });
		expect(h.prompts[0]).toMatchObject({
			verb: "current",
			write: false,
			detail: "Read the URL and title of every open tab",
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.data.text).toContain("- Page URL: https://app.example.test/home?token=[redacted]");
		expect(answer.data.text).toContain("[active] 7: Home");
		expect(answer.data.text).toContain("- 8: (browser page)");
		expect(answer.data.text).not.toContain("chrome://settings");
	});

	it("opens a new tab only after approval", async () => {
		const h = harness();
		const answer = await h.run({ verb: "open", url: "https://example.test/" });
		expect(h.prompts[0]).toMatchObject({
			verb: "open",
			write: true,
			detail: "Open https://example.test/ in a new tab",
		});
		expect(h.created).toEqual([
			{ url: "https://example.test/", windowId: 3, active: true },
		]);
		expect(answer).toMatchObject({ ok: true });
	});

	it("returns a screenshot of the approved tab", async () => {
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
		expect(h.prompts).toEqual([]);
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

	it("describes the click target in the approval", async () => {
		const h = harness({
			describeResult: {
				element: { tag: "button", role: "button", name: "Save", text: "Save now" },
			},
			pageResult: { detail: 'clicked button "Save"' },
		});
		await h.run({ verb: "click", target: "e1" });
		expect(h.described).toEqual([{ kind: "describe", target: "e1" }]);
		expect(h.prompts[0]?.detail).toBe(
			'Click e1\nElement: button "Save" <button>\nText: Save now',
		);
	});

	it("refuses before any prompt when the target does not resolve", async () => {
		const h = harness({ describeResult: { error: "No element matches #x." } });
		expect(await h.run({ verb: "fill", target: "#x", value: "a" })).toEqual({
			ok: false,
			error: "No element matches #x.",
		});
		expect(h.prompts).toEqual([]);
		expect(h.executed).toEqual([]);
	});

	it("uploads a staged asset after an approval that names the file and the element", async () => {
		const h = harness({
			describeResult: {
				element: { tag: "input", role: "button", name: "Attach", text: "" },
			},
			pageResult: { detail: 'uploaded demo.webm to button "Attach"' },
			asset: new Blob(["hello"], { type: "video/webm" }),
		});
		const answer = await h.run(UPLOAD);
		expect(h.prompts[0]).toMatchObject({ verb: "upload", write: true });
		expect(h.prompts[0]?.detail).toBe(
			'Upload ~/work/demo.webm\nFile: demo.webm, 5 B, video/webm\nTo: https://app.example.test\nElement: button "Attach" <input>',
		);
		expect(h.fetched).toEqual([UPLOAD.assetId as string]);
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

	it("refuses an upload whose staged bytes do not match the approved size", async () => {
		const h = harness({ asset: new Blob(["longer than five"]) });
		expect(await h.run(UPLOAD)).toEqual({
			ok: false,
			error: expect.stringContaining("size"),
		});
		expect(h.executed).toEqual([]);
	});

	it("refuses an upload to a plain http page before any prompt", async () => {
		const h = harness({ tabs: [{ ...WEB_TAB, url: "http://app.example.test/" }] });
		expect(await h.run(UPLOAD)).toEqual({
			ok: false,
			error: expect.stringContaining("https"),
		});
		expect(h.prompts).toEqual([]);
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
						description: "Search issues with token=abcdef123456",
						inputSchema: '{"type":"object"}',
					},
				],
			}),
		});
		const listed = await some.run({ verb: "tools" });
		expect(some.prompts[0]).toMatchObject({ verb: "tools", write: false });
		expect(listed.ok && listed.data.text).toContain("- search: Search issues");
		expect(listed.ok && listed.data.text).toContain('input: {"type":"object"}');
		expect(listed.ok && listed.data.text).not.toContain("abcdef123456");
	});

	it("calls a WebMCP tool after an approval with its description and exact args", async () => {
		const actions: unknown[] = [];
		const h = harness({
			mainResult: (action) => {
				actions.push(action);
				return (action as { kind: string }).kind === "tools"
					? {
							api: "modelContext",
							tools: [
								{
									name: "search",
									description: "Search issues",
									annotations: '{"readOnlyHint":true}',
								},
							],
						}
					: { api: "modelContext", output: "3 results" };
			},
		});
		const answer = await h.run({ verb: "call", tool: "search", args: { q: "bug" } });
		expect(h.prompts[0]).toMatchObject({ verb: "call", write: true });
		expect(h.prompts[0]?.detail).toBe(
			'Call WebMCP tool search\nDescription: Search issues\nHints: {"readOnlyHint":true}\nArgs:\n{\n  "q": "bug"\n}',
		);
		expect(actions[1]).toMatchObject({ kind: "call", tool: "search", args: { q: "bug" } });
		expect(answer.ok && answer.data.text).toContain("3 results");
	});

	it("refuses to call a tool the page does not expose, before any prompt", async () => {
		const h = harness({ mainResult: () => ({ api: "none", tools: [] }) });
		expect(await h.run({ verb: "call", tool: "search", args: {} })).toEqual({
			ok: false,
			error: expect.stringContaining("No WebMCP tool"),
		});
		expect(h.prompts).toEqual([]);
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
