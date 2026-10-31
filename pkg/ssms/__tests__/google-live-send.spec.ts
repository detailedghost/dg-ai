import { describe, expect, test } from "bun:test";
import { createScriptedMessagesBrowser } from "../src/google/browser";

interface LiveLink {
	id: string;
	name: string;
}

function idOf(href: string): string {
	const match = /\/conversations\/([^/?#]+)/.exec(href);
	return match ? decodeURIComponent(match[1]) : "";
}

function createLivePage(input: {
	href: string;
	header: string;
	links: LiveLink[];
	urlDelayMs: number;
	paneDelayMs: number;
	headerDelayMs: number;
}) {
	let href = input.href;
	let header = input.header;
	let selectedId = idOf(input.href);
	let pane = `pane-${selectedId || "start"}`;
	let slept = 0;
	let clicked: { id: string; at: number } | null = null;
	const clicks: string[] = [];
	const typed: string[] = [];
	const sentAt: string[] = [];
	const sleeps: number[] = [];
	const proto = {};
	Object.defineProperty(proto, "value", {
		configurable: true,
		set(value: string) {
			typed.push(`${pane}:${value}`);
		},
		get() {
			return typed.at(-1)?.split(":").slice(1).join(":") ?? "";
		},
	});
	const box = { tagName: "TEXTAREA", dispatchEvent() {} };
	Object.setPrototypeOf(box, proto);
	const sendButton = {
		tagName: "BUTTON",
		innerText: "Send",
		textContent: "Send",
		disabled: false,
		getAttribute(name: string) {
			return name === "aria-label" ? "Send" : null;
		},
		click() {
			sentAt.push(`${pane}|${href}`);
		},
	};
	const heading = {
		get innerText() {
			return header;
		},
		get textContent() {
			return header;
		},
	};
	const main = {
		getAttribute(name: string) {
			return name === "data-dg-pane" ? pane : null;
		},
		setAttribute() {},
		querySelector(selector: string) {
			if (selector.includes("h1") || selector.includes("heading")) return heading;
			if (selector.includes("textarea") || selector.includes("contenteditable")) return box;
			return null;
		},
		querySelectorAll(selector: string) {
			if (selector.includes("button")) return [sendButton];
			return [];
		},
	};
	const links = input.links.map((link) => ({
		getAttribute(name: string) {
			if (name === "href") return `/web/u/0/conversations/${link.id}`;
			if (name === "aria-selected") return selectedId === link.id ? "true" : null;
			return null;
		},
		click() {
			clicks.push(link.id);
			clicked = { id: link.id, at: slept };
		},
	}));
	const document = {
		querySelector(selector: string) {
			if (selector === '[role="main"]' || selector === "main") return main;
			return null;
		},
		querySelectorAll(selector: string) {
			if (selector.includes("conversations")) return links;
			return [];
		},
	};
	const location = {
		get href() {
			return href;
		},
	};
	function sync(): void {
		if (!clicked) return;
		const age = slept - clicked.at;
		const link = input.links.find((item) => item.id === clicked?.id);
		if (age >= input.urlDelayMs) {
			href = `https://messages.google.com/web/u/0/conversations/${clicked.id}`;
			selectedId = clicked.id;
		}
		if (link && age >= input.headerDelayMs) header = link.name;
		if (age >= input.paneDelayMs) pane = `pane-${clicked.id}`;
	}
	return {
		clicks,
		typed,
		sentAt,
		sleeps,
		page: {
			async evaluate(expression: string) {
				sync();
				const fn = new Function("document", "location", "Event", `return (${expression});`);
				return fn(document, location, Event);
			},
		},
		sleep: async (ms: number) => {
			slept += ms;
			sleeps.push(ms);
			sync();
		},
	};
}

async function send(
	live: ReturnType<typeof createLivePage>,
	conversationId: string,
	recipient: string,
	extra: Record<string, unknown> = {},
) {
	const browser = createScriptedMessagesBrowser(live.page, { sleep: live.sleep });
	return browser.act("send", {
		confirmed: true,
		conversationId,
		recipient,
		text: "hello there",
		draftId: "d1",
		rng: () => 0,
		...extra,
	});
}

function together(ms: number) {
	return { urlDelayMs: ms, paneDelayMs: ms, headerDelayMs: ms };
}

describe("live Google send", () => {
	test("a different thread is open, then the click reaches the named contact", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/99",
			header: "Pat",
			...together(30),
			links: [
				{ id: "123", name: "Bob" },
				{ id: "12", name: "Ada Lovelace" },
			],
		});
		const sent = (await send(live, "12", "Ada Lovelace")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.clicks).toEqual(["12"]);
		expect(live.sleeps.length).toBeGreaterThan(0);
		expect(live.typed).toEqual(["pane-12:hello there"]);
		expect(live.sentAt[0]).toMatch(/\/conversations\/12$/);
	});

	test("the target thread is already open under the contact's name", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/12",
			header: "Ada Lovelace",
			...together(0),
			links: [
				{ id: "123", name: "Bob" },
				{ id: "12", name: "Ada Lovelace" },
			],
		});
		const sent = (await send(live, "12", "Ada Lovelace")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.clicks).toEqual(["12"]);
		expect(live.sentAt[0]).toMatch(/\/conversations\/12$/);
		expect(live.typed).toEqual(["pane-12:hello there"]);
	});

	test("id 12 does not send into the open thread 123", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/123",
			header: "Ada Lovelace",
			...together(0),
			links: [
				{ id: "123", name: "Ada Lovelace" },
				{ id: "12", name: "Ada Lovelace" },
			],
		});
		const sent = (await send(live, "12", "Ada Lovelace")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.clicks).toEqual(["12"]);
		expect(live.sentAt[0]).toContain("pane-12|");
		expect(live.sentAt[0]).toMatch(/\/conversations\/12$/);
		expect(live.sentAt[0]).not.toMatch(/\/conversations\/123$/);
	});

	test("the URL can update before the message pane", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/1",
			header: "Bob",
			urlDelayMs: 30,
			headerDelayMs: 30,
			paneDelayMs: 3000,
			links: [
				{ id: "1", name: "Bob" },
				{ id: "2", name: " Cara " },
			],
		});
		const sent = (await send(live, "2", "Cara")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.typed).toEqual(["pane-2:hello there"]);
		expect(live.sentAt[0]).toContain("pane-2|");
		expect(live.sleeps.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThanOrEqual(3000);
	});

	test("Al is not sent from Alice when the URL moves first", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/123",
			header: "Alice",
			urlDelayMs: 30,
			headerDelayMs: 3000,
			paneDelayMs: 3000,
			links: [
				{ id: "123", name: "Alice" },
				{ id: "12", name: "Al" },
			],
		});
		const sent = (await send(live, "12", "Al")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.typed).toEqual(["pane-12:hello there"]);
		expect(live.sentAt[0]).toContain("pane-12|");
		expect(live.sentAt[0]).not.toContain("pane-123|");
		expect(live.sleeps.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThanOrEqual(3000);
	});

	test("two contacts named Mom require the pane to switch", async () => {
		const early = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/5",
			header: "Mom",
			urlDelayMs: 30,
			headerDelayMs: 0,
			paneDelayMs: 3000,
			links: [
				{ id: "5", name: "Mom" },
				{ id: "9", name: "Mom" },
			],
		});
		await expect(
			send(early, "9", "Mom", { ambiguous: true, timeoutMs: 500 }),
		).rejects.toThrow("ambiguous recipient");
		expect(early.typed).toEqual([]);
		expect(early.sentAt).toEqual([]);

		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/5",
			header: "Mom",
			urlDelayMs: 30,
			headerDelayMs: 0,
			paneDelayMs: 3000,
			links: [
				{ id: "5", name: "Mom" },
				{ id: "9", name: "Mom" },
			],
		});
		const sent = (await send(live, "9", "Mom", { ambiguous: true })) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.typed).toEqual(["pane-9:hello there"]);
		expect(live.sentAt[0]).toContain("pane-9|");
		expect(live.sentAt[0]).not.toContain("pane-5|");
		expect(live.sleeps.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThanOrEqual(3000);
	});
});
