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
		afterApproval?: Partial<Tab>;
		chromium?: boolean;
		capture?: string;
	} = {},
) {
	let tabs = options.tabs ?? [WEB_TAB];
	const prompts: PwExtApprovalPrompt[] = [];
	const executed: unknown[] = [];
	const created: unknown[] = [];
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
			get: mock(async (id: number) => {
				const tab = tabs.find((candidate) => candidate.id === id);
				if (!tab) throw new Error("No tab");
				return tab;
			}),
			create: mock(async (props: unknown) => {
				created.push(props);
				return { id: 99, windowId: 3, url: (props as { url: string }).url };
			}),
			captureVisibleTab: mock(
				async () => options.capture ?? "data:image/jpeg;base64,AAAA",
			),
		},
		scripting: {
			executeScript: mock(async (details: { args: unknown[] }) => {
				executed.push(details);
				return [{ frameId: 0, result: options.pageResult }];
			}),
		},
	} as unknown as PwExtBrowserApi;
	const approve = mock(async (prompt: PwExtApprovalPrompt) => {
		prompts.push(prompt);
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
		run: (request: PwExtRequest) => handler(request, 60_000),
		api,
		prompts,
		executed,
		created,
	};
}

describe("pw --ext background handler", () => {
	it("asks once per read, naming the tab, then returns a redacted snapshot", async () => {
		const h = harness({
			pageResult: {
				title: "Home",
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
			detail: 'Fill e2 with "cats"',
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
		expect(h.prompts[0]).toMatchObject({ verb: "current", write: false });
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
