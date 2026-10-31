import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalMessagesBrowser } from "../src/google/browser";
import { createGoogleProvider } from "../src/google/provider";
import { asTextArea, createDocument, node, readyThread } from "./support/document";

describe("google provider", () => {
	test("receive waits with irregular gaps until a message appears", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-grecv-"));
		let reads = 0;
		const doc = createDocument(
			[
				node("c1", { href: "/web/conversations/c1" }),
				node("secret-body", { id: "m9", datetime: "9", "aria-label": "ada" }, "MWS-MESSAGE-WRAPPER"),
			],
			"Conversations",
		);
		const browser = createLocalMessagesBrowser(doc);
		const real = browser.act.bind(browser);
		browser.act = async (action, args) => {
			if (action === "read") {
				reads += 1;
				if (reads === 1) return { messages: [] };
			}
			return real(action, args);
		};
		const waits: number[] = [];
		let clock = 0;
		const provider = createGoogleProvider({
			browser,
			home,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
			rng: () => 0,
		});
		const messages = await provider.receive({ limit: 1, timeoutMs: 10_000, conversationId: "c1" });
		expect(messages.map((item) => item.id)).toEqual(["m9"]);
		expect(waits).toEqual([200]);
		expect(JSON.stringify(messages[0]?.text)).toBe('"secret-body"');
	});

	test("a second quiet poll does not reuse the same gap", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-gquiet-"));
		const doc = createDocument([node("c1", { href: "/web/conversations/c1" })], "");
		const browser = createLocalMessagesBrowser(doc);
		const waits: number[] = [];
		let clock = 0;
		const rolls = [0, 0, 0, 0, 0, 0];
		let index = 0;
		const provider = createGoogleProvider({
			browser,
			home,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
			rng: () => rolls[index++] ?? 0,
		});
		await provider.receive({ limit: 1, timeoutMs: 600, conversationId: "c1" });
		expect(waits.length).toBeGreaterThan(1);
		expect(waits[0]).not.toBe(waits[1]);
		expect(new Set(waits).size).toBeGreaterThan(1);
	});

	test("a draft stores the contact name, and a miss before typing stays pending", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-gdraft-"));
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		const doc = createDocument(
			[
				node("hello", { href: "/web/conversations/c1", "aria-label": "Ada Lovelace" }),
				box,
				send,
			],
			"",
		);
		readyThread(doc, "c1", "Pat");
		const provider = createGoogleProvider({
			browser: createLocalMessagesBrowser(doc),
			home,
			ids: () => "draft-1",
			now: () => 0,
		});
		const draft = await provider.draftReply({ conversationId: "c1", text: "hello there" });
		expect(draft.recipient).toBe("Ada Lovelace");
		expect(draft.recipient).not.toBe(draft.conversationId);
		await expect(
			provider.sendDraft({ draftId: draft.id, confirmed: true, hook: false }),
		).rejects.toThrow("open conversation timed out");
		const stored = JSON.parse(readFileSync(join(home, "ssms", "drafts", "draft-1.json"), "utf8")) as {
			status: string;
		};
		expect(stored.status).toBe("pending");
		expect(existsSync(join(home, "ssms", "drafts", "draft-1.sending"))).toBe(false);
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
	});

	test("two conversations with the same name are not sent", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-moms-"));
		let sends = 0;
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "9";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "9";
		const doc = createDocument(
			[
				node("Mom", { href: "/web/conversations/5", "aria-label": "Mom" }),
				node("Mom", { href: "/web/conversations/9", "aria-label": "Mom" }),
				box,
				send,
			],
			"",
		);
		readyThread(doc, "9", "Mom");
		const browser = createLocalMessagesBrowser(doc);
		const act = browser.act.bind(browser);
		browser.act = async (action, args) => {
			if (action === "send") sends += 1;
			return act(action, args);
		};
		const provider = createGoogleProvider({
			browser,
			home,
			ids: () => "draft-mom",
			now: () => 0,
		});
		const draft = await provider.draftReply({ conversationId: "9", text: "hello there" });
		expect(draft.ambiguousRecipient).toBe(true);
		await expect(
			provider.sendDraft({ draftId: draft.id, confirmed: true, hook: false }),
		).rejects.toThrow("ambiguous recipient");
		expect(sends).toBe(0);
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
		const stored = JSON.parse(readFileSync(join(home, "ssms", "drafts", "draft-mom.json"), "utf8")) as {
			status: string;
		};
		expect(stored.status).toBe("pending");
	});

	test("a second Mom past the first page makes the draft ambiguous", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-page-mom-"));
		let revealed = false;
		const mom5 = node("hi", { href: "/web/conversations/5", "aria-label": "Mom" });
		const mom9 = node("hi", { href: "/web/conversations/9", "aria-label": "Mom" });
		const more = node("Load more conversations");
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "5";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "5";
		const nodes = [mom5, more, box, send];
		const doc = {
			clicks: [] as string[],
			body: { textContent: "Conversations" },
			location: { href: "https://messages.google.com/web/u/0/conversations/5" },
			threadHeader: "Mom",
			paneConversationId: "5",
			querySelectorAll(selector: string) {
				if (selector !== "*") return [];
				return revealed ? [mom5, mom9, box, send] : nodes;
			},
		};
		mom5.attrs["aria-selected"] = "true";
		const provider = createGoogleProvider({
			browser: createLocalMessagesBrowser(doc),
			home,
			ids: () => "draft-page",
			now: () => 0,
			sleep: async () => {
				revealed = true;
			},
			rng: () => 0,
		});
		const draft = await provider.draftReply({ conversationId: "5", text: "hello there" });
		expect(draft.ambiguousRecipient).toBe(true);
		await expect(
			provider.sendDraft({ draftId: draft.id, confirmed: true, hook: false }),
		).rejects.toThrow("ambiguous recipient");
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
	});

	test("a draft without the duplicate-name flag is refused", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-old-draft-"));
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		const doc = createDocument(
			[node("hello", { href: "/web/conversations/c1", "aria-label": "Ada" }), box, send],
			"",
		);
		readyThread(doc, "c1", "Ada");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(home, "ssms", "drafts"), { recursive: true });
		writeFileSync(
			join(home, "ssms", "drafts", "old.json"),
			`${JSON.stringify({
				id: "old",
				provider: "google",
				conversationId: "c1",
				recipient: "Ada",
				text: "hello there",
				attachments: [],
				createdAt: "2026-10-31T00:00:00.000Z",
				status: "pending",
			})}\n`,
		);
		const provider = createGoogleProvider({
			browser: createLocalMessagesBrowser(doc),
			home,
			now: () => 0,
		});
		await expect(
			provider.sendDraft({ draftId: "old", confirmed: true, hook: false }),
		).rejects.toThrow("ambiguous recipient");
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
	});
});
