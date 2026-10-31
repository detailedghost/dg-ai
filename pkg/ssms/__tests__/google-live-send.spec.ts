import { describe, expect, test } from "bun:test";
import { createScriptedMessagesBrowser } from "../src/google/browser";

interface LiveLink {
	id: string;
	name: string;
}

function createLivePage(input: {
	href: string;
	header: string;
	links: LiveLink[];
	openDelayMs: number;
}) {
	let href = input.href;
	let header = input.header;
	let slept = 0;
	let pending: { id: string; readyAt: number } | null = null;
	const clicks: string[] = [];
	const typed: string[] = [];
	const sentAt: string[] = [];
	const sleeps: number[] = [];
	const proto = {};
	Object.defineProperty(proto, "value", {
		configurable: true,
		set(value: string) {
			typed.push(value);
		},
		get() {
			return typed.at(-1) ?? "";
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
			sentAt.push(href);
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
			return name === "href" ? `/web/u/0/conversations/${link.id}` : null;
		},
		click() {
			clicks.push(link.id);
			pending = { id: link.id, readyAt: slept + input.openDelayMs };
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
	function applyPending(): void {
		if (!pending || slept < pending.readyAt) return;
		const chosen = input.links.find((link) => link.id === pending?.id);
		href = `https://messages.google.com/web/u/0/conversations/${pending.id}`;
		if (chosen) header = chosen.name;
		pending = null;
	}
	return {
		clicks,
		typed,
		sentAt,
		sleeps,
		page: {
			async evaluate(expression: string) {
				applyPending();
				const fn = new Function("document", "location", "Event", `return (${expression});`);
				return fn(document, location, Event);
			},
		},
		sleep: async (ms: number) => {
			slept += ms;
			sleeps.push(ms);
			applyPending();
		},
	};
}

async function send(live: ReturnType<typeof createLivePage>, conversationId: string, recipient: string) {
	const browser = createScriptedMessagesBrowser(live.page, { sleep: live.sleep });
	return browser.act("send", {
		confirmed: true,
		conversationId,
		recipient,
		text: "hello there",
		draftId: "d1",
	});
}

describe("live Google send", () => {
	test("a different thread is open, then the click reaches the named contact", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/99",
			header: "Pat",
			openDelayMs: 30,
			links: [
				{ id: "123", name: "Bob" },
				{ id: "12", name: "Ada Lovelace" },
			],
		});
		const sent = (await send(live, "12", "Ada Lovelace")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.clicks).toEqual(["12"]);
		expect(live.sleeps.length).toBeGreaterThan(0);
		expect(live.typed).toEqual(["hello there"]);
		expect(live.sentAt[0]).toMatch(/\/conversations\/12$/);
	});

	test("the target thread is already open under the contact's name", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/12",
			header: "Ada Lovelace",
			openDelayMs: 0,
			links: [
				{ id: "123", name: "Bob" },
				{ id: "12", name: "Ada Lovelace" },
			],
		});
		const sent = (await send(live, "12", "Ada Lovelace")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.clicks).toEqual(["12"]);
		expect(live.sentAt[0]).toMatch(/\/conversations\/12$/);
		expect(live.typed).toEqual(["hello there"]);
	});

	test("id 12 does not send into the open thread 123", async () => {
		const live = createLivePage({
			href: "https://messages.google.com/web/u/0/conversations/123",
			header: "Ada Lovelace",
			openDelayMs: 0,
			links: [
				{ id: "123", name: "Ada Lovelace" },
				{ id: "12", name: "Ada Lovelace" },
			],
		});
		const sent = (await send(live, "12", "Ada Lovelace")) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(live.clicks).toEqual(["12"]);
		expect(live.sentAt[0]).toMatch(/\/conversations\/12$/);
		expect(live.sentAt[0]).not.toMatch(/\/conversations\/123$/);
	});
});
