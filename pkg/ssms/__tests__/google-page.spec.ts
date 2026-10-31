import { describe, expect, test } from "bun:test";
import { evaluateMessagesAction } from "../src/google/page";
import { createDocument, node } from "./support/document";

describe("Messages page actions", () => {
	test("status reports the phone banner, sign-in, and a paired list", () => {
		const banner = createDocument([], "Trying to reach your phone");
		expect(evaluateMessagesAction(banner, "status", {})).toMatchObject({
			state: "phone-unreachable",
			reason: "phone-banner",
		});
		const signedOut = createDocument([], "Sign in to continue");
		expect(evaluateMessagesAction(signedOut, "status", {})).toMatchObject({
			state: "signed-out",
			reason: "sign-in",
		});
		const paired = createDocument(
			[node("hi", { href: "/web/conversations/c1", "aria-label": "Ada" })],
			"Conversations",
		);
		expect(evaluateMessagesAction(paired, "status", {})).toMatchObject({
			state: "paired",
			reason: "conversation-list",
			count: 1,
		});
	});

	test("list loads more until the button is gone and can stop at a scope", () => {
		const nowMs = Date.parse("2026-10-31T00:00:00.000Z");
		const young = node("hi", {
			href: "/web/conversations/c1",
			"aria-label": "Ada",
			datetime: new Date(nowMs - 86400000).toISOString(),
		});
		const more = node("Load more conversations");
		const doc = createDocument([young, more], "");
		const listed = evaluateMessagesAction(doc, "list", { scopeDays: null, nowMs }) as {
			conversations: { id: string }[];
			clicks: string[];
		};
		expect(listed.conversations.map((row) => row.id)).toEqual(["c1"]);
		expect(listed.clicks).toEqual(["Load more conversations"]);
		const old = node("stale", {
			href: "/web/conversations/old",
			"aria-label": "Old",
			datetime: new Date(nowMs - 9 * 86400000).toISOString(),
		});
		const scoped = createDocument([old, node("Load more conversations")], "");
		const stopped = evaluateMessagesAction(scoped, "list", { scopeDays: 3, nowMs }) as {
			conversations: { id: string }[];
			clicks: string[];
		};
		expect(stopped.clicks).toEqual([]);
		expect(stopped.conversations).toEqual([]);
	});

	test("read returns the newest messages up to the limit", () => {
		const doc = createDocument(
			[
				node("c1", { href: "/web/conversations/c1" }),
				node("secret-body", { id: "m1", datetime: "1", "aria-label": "ada" }, "MWS-MESSAGE-WRAPPER"),
				node(
					"later",
					{ id: "m2", datetime: "5", "aria-label": "ada", type: "image/jpeg" },
					"MWS-MESSAGE-WRAPPER",
				),
			],
			"",
		);
		const read = evaluateMessagesAction(doc, "read", { conversationId: "c1", limit: 1 }) as {
			messages: {
				id: string;
				conversationId: string;
				timestamp: number;
				senderId: string;
				text: string;
				contentType: string;
			}[];
		};
		expect(read.messages).toEqual([
			{
				id: "m2",
				conversationId: "c1",
				timestamp: 5,
				senderId: "ada",
				text: "later",
				contentType: "image/jpeg",
			},
		]);
		const none = evaluateMessagesAction(doc, "read", { conversationId: "c1", limit: 0 }) as {
			messages: unknown[];
		};
		expect(none.messages).toEqual([]);
	});

	test("archive and block click those controls and never click Delete or Send", () => {
		function menu() {
			return createDocument(
				[
					node("c1", { href: "/web/conversations/c1" }),
					node("Options"),
					node("Details"),
					node("Archive"),
					node("Block & report spam"),
					node("Delete"),
					node("Send"),
				],
				"",
			);
		}
		const archived = menu();
		const archive = evaluateMessagesAction(archived, "archive", { conversationId: "c1" }) as {
			reason: string;
			clicks: string[];
		};
		expect(archive.reason).toBe("archived");
		expect(archive.clicks).toEqual(["open:c1", "Options", "Archive"]);
		expect(archive.clicks).not.toContain("Delete");
		expect(archive.clicks).not.toContain("Send");
		const blocked = menu();
		const block = evaluateMessagesAction(blocked, "block", { conversationId: "c1" }) as {
			reason: string;
			clicks: string[];
		};
		expect(block.reason).toBe("blocked");
		expect(block.clicks).toEqual(["open:c1", "Details", "Block & report spam"]);
		expect(block.clicks).not.toContain("Delete");
		expect(block.clicks).not.toContain("Send");
	});

	test("send opens the draft conversation, types through the value setter, and refuses a mismatch", () => {
		function HTMLTextAreaElement() {}
		Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
			set(this: { nativeValue?: string; usedNativeSetter?: boolean }, value: string) {
				this.usedNativeSetter = true;
				this.nativeValue = value;
			},
			get(this: { nativeValue?: string }) {
				return this.nativeValue ?? "";
			},
		});
		const previous = (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement;
		(globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement = HTMLTextAreaElement;
		try {
			const box = node("", { "data-compose": "true", "aria-label": "Text message" });
			(box as { tagName?: string; dispatchEvent?: (event: Event) => void; events?: string[] }).tagName =
				"TEXTAREA";
			(box as { events?: string[] }).events = [];
			(box as { dispatchEvent?: (event: Event) => void }).dispatchEvent = (event) => {
				((box as { events?: string[] }).events ?? []).push(event.type);
			};
			const wrong = createDocument(
				[
					node("c1", { href: "/web/conversations/c1" }),
					node("c2", { href: "/web/conversations/c2" }),
					box,
					node("Send", { "aria-label": "Send" }),
				],
				"",
			);
			(wrong as { openConversationId?: string }).openConversationId = "c2";
			expect(() =>
				evaluateMessagesAction(wrong, "send", {
					confirmed: true,
					conversationId: "c1",
					text: "hello there",
					draftId: "d1",
				}),
			).toThrow(/does not match/);
			expect(wrong.clicks).not.toContain("Send");
			const matched = createDocument(
				[
					node("c1", { href: "/web/conversations/c1" }),
					box,
					node("Send", { "aria-label": "Send" }),
				],
				"",
			);
			(matched as { openConversationId?: string }).openConversationId = "c1";
			const sent = evaluateMessagesAction(matched, "send", {
				confirmed: true,
				conversationId: "c1",
				text: "hello there",
				draftId: "d1",
			}) as { reason: string; clicks: string[] };
			expect(sent.reason).toBe("sent");
			expect(sent.clicks).toContain("Send");
			expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).toBe(true);
			expect((box as { events?: string[] }).events).toContain("input");
			expect((box as { nativeValue?: string }).nativeValue).toBe("hello there");
		} finally {
			(globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement = previous;
		}
	});

	test("a disabled Send button and a data-attribute-only row fail closed", () => {
		const disabled = createDocument(
			[
				node("c1", { href: "/web/conversations/c1" }),
				node("", { "aria-label": "Text message" }, "TEXTAREA"),
				node("Send", { "aria-label": "Send", "aria-disabled": "true" }),
			],
			"",
		);
		(disabled as { openConversationId?: string }).openConversationId = "c1";
		expect(() =>
			evaluateMessagesAction(disabled, "send", {
				confirmed: true,
				conversationId: "c1",
				text: "hi",
				draftId: "d1",
			}),
		).toThrow("send control disabled");
		expect(disabled.clicks).not.toContain("Send");
		const fixtureOnly = createDocument(
			[node("", { "data-conversation-id": "c1" }), node("Archive"), node("Options")],
			"",
		);
		expect(() => evaluateMessagesAction(fixtureOnly, "archive", { conversationId: "c1" })).toThrow(
			"conversation not found",
		);
	});

	test("delete is refused and send waits for confirmation", () => {
		const doc = createDocument(
			[
				node("Delete"),
				node("c1", { href: "/web/conversations/c1" }),
				node("", { "aria-label": "Text message" }, "TEXTAREA"),
				node("Send", { "aria-label": "Send" }),
			],
			"",
		);
		expect(() => evaluateMessagesAction(doc, "delete", {})).toThrow("delete is disabled");
		expect(doc.clicks).toEqual([]);
		expect(() => evaluateMessagesAction(doc, "send", { confirmed: false, text: "hi" })).toThrow(
			"send requires confirmation",
		);
		expect(doc.clicks).toEqual([]);
		const sent = evaluateMessagesAction(doc, "send", {
			confirmed: true,
			conversationId: "c1",
			text: "hi",
			draftId: "d1",
		}) as { reason: string; clicks: string[] };
		expect(sent.reason).toBe("sent");
		expect(sent.clicks).toContain("Send");
		expect(sent.clicks).not.toContain("Delete");
	});
});
