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
			[node("", { "data-conversation-id": "c1", "data-sender": "Ada", "data-preview": "hi" })],
			"Conversations",
		);
		expect(evaluateMessagesAction(paired, "status", {})).toMatchObject({
			state: "paired",
			reason: "conversation-list",
			count: 1,
		});
	});

	test("list loads more until the button is gone and can stop at a scope", () => {
		const young = node("", {
			"data-conversation-id": "c1",
			"data-sender": "Ada",
			"data-preview": "hi",
			"data-age-days": "1",
		});
		const more = node("Load more conversations");
		const doc = createDocument([young, more], "");
		const listed = evaluateMessagesAction(doc, "list", { scopeDays: null }) as {
			conversations: { id: string }[];
			clicks: string[];
		};
		expect(listed.conversations.map((row) => row.id)).toEqual(["c1"]);
		expect(listed.clicks).toEqual(["Load more conversations"]);
		const old = node("", {
			"data-conversation-id": "old",
			"data-age-days": "9",
			"data-sender": "Old",
			"data-preview": "stale",
		});
		const scoped = createDocument([old, node("Load more conversations")], "");
		const stopped = evaluateMessagesAction(scoped, "list", { scopeDays: 3 }) as {
			conversations: { id: string }[];
			clicks: string[];
		};
		expect(stopped.clicks).toEqual([]);
		expect(stopped.conversations).toEqual([]);
	});

	test("read returns the newest messages up to the limit", () => {
		const doc = createDocument(
			[
				node("secret-body", {
					"data-message-id": "m1",
					"data-conversation-id": "c1",
					"data-timestamp": "1",
					"data-text": "secret-body",
					"data-sender-id": "ada",
				}),
				node("later", {
					"data-message-id": "m2",
					"data-conversation-id": "c1",
					"data-timestamp": "5",
					"data-text": "later",
					"data-sender-id": "ada",
					"data-content-type": "image/jpeg",
				}),
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
					node("", { "data-conversation-id": "c1" }),
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

	test("delete is refused and send waits for confirmation", () => {
		const doc = createDocument([node("Delete"), node("Send"), node("", { "data-compose": "true" })], "");
		expect(() => evaluateMessagesAction(doc, "delete", {})).toThrow("delete is disabled");
		expect(doc.clicks).toEqual([]);
		expect(() => evaluateMessagesAction(doc, "send", { confirmed: false, text: "hi" })).toThrow(
			"send requires confirmation",
		);
		expect(doc.clicks).toEqual([]);
		const sent = evaluateMessagesAction(doc, "send", {
			confirmed: true,
			text: "hi",
			draftId: "d1",
		}) as { reason: string; clicks: string[] };
		expect(sent.reason).toBe("sent");
		expect(sent.clicks).toEqual(["Send"]);
	});
});
