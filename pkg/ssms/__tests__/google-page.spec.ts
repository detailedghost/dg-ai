import { describe, expect, test } from "bun:test";
import { evaluateMessagesAction } from "../src/google/page";
import { prepareSend, resolveOpenTimeout, DEFAULT_OPEN_TIMEOUT_MS } from "../src/google/thread";
import { asTextArea, createDocument, node, readyThread } from "./support/document";

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

	test("send waits for the open URL and refuses the thread that is still showing", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c2";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c2";
		const wrong = createDocument(
			[
				node("Search", { "aria-label": "Search" }, "INPUT"),
				node("c1", { href: "/web/conversations/c1" }),
				box,
				send,
			],
			"",
		);
		readyThread(wrong, "c2", "Bea");
		await expect(
			evaluateMessagesAction(wrong, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hello there",
				draftId: "d1",
				timeoutMs: 0,
			}),
		).rejects.toThrow("open conversation timed out");
		expect(wrong.clicks).not.toContain("Send");
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
	});

	test("send types into the open conversation pane after the URL and header match", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const events: string[] = [];
		box.dispatchEvent = (event) => {
			if (event) events.push(event.type);
		};
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		const matched = createDocument(
			[node("Search", { "aria-label": "Search" }, "INPUT"), node("c1", { href: "/web/conversations/c1" }), box, send],
			"",
		);
		readyThread(matched, "c1", "Ada");
		const sent = (await evaluateMessagesAction(matched, "send", {
			confirmed: true,
			conversationId: "c1",
			recipient: "Ada",
			text: "hello there",
			draftId: "d1",
		})) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(matched.clicks).toContain("Send");
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).toBe(true);
		expect((box as { nativeValue?: string }).nativeValue).toBe("hello there");
		expect(events).toContain("input");
	});

	test("a disabled Send button and a data-attribute-only row fail closed", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const send = node("Send", { "aria-label": "Send", "aria-disabled": "true" });
		send.paneId = "c1";
		const disabled = createDocument(
			[node("c1", { href: "/web/conversations/c1" }), box, send],
			"",
		);
		readyThread(disabled, "c1", "Ada");
		await expect(
			evaluateMessagesAction(disabled, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hi",
				draftId: "d1",
			}),
		).rejects.toThrow("send control disabled");
		expect(disabled.clicks).not.toContain("Send");
		const fixtureOnly = createDocument(
			[node("", { "data-conversation-id": "c1" }), node("Archive"), node("Options")],
			"",
		);
		expect(() => evaluateMessagesAction(fixtureOnly, "archive", { conversationId: "c1" })).toThrow(
			"conversation not found",
		);
	});

	test("send fails closed unless the URL and the recipient header both match", async () => {
		const open = (hrefId: string, header: string) => {
			const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
			box.paneId = "c1";
			const send = node("Send", { "aria-label": "Send" });
			send.paneId = "c1";
			const doc = createDocument(
				[node(hrefId, { href: `/web/conversations/${hrefId}` }), box, send],
				"",
			);
			readyThread(doc, hrefId, header);
			return { doc, box };
		};
		const urlOnly = open("c1", "Bea");
		await expect(
			evaluateMessagesAction(urlOnly.doc, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hello there",
				draftId: "d1",
				timeoutMs: 0,
			}),
		).rejects.toThrow("open conversation timed out");
		expect(urlOnly.doc.clicks).not.toContain("Send");
		const headerOnly = open("c1", "Ada");
		(headerOnly.doc as unknown as { location: { href: string } }).location = {
			href: "https://messages.google.com/web/u/0/conversations/c2",
		};
		await expect(
			evaluateMessagesAction(headerOnly.doc, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hello there",
				draftId: "d1",
			}),
		).rejects.toThrow("open conversation timed out");
		expect(headerOnly.doc.clicks).not.toContain("Send");
		expect((headerOnly.box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
	});

	test("send uses only the compose box and Send control inside the open pane", async () => {
		const otherBox = asTextArea(node("other-box", { "aria-label": "Text message" }, "TEXTAREA"));
		otherBox.paneId = "other";
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const otherSend = node("Send message", { "aria-label": "Send message" });
		otherSend.paneId = "other";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		const doc = createDocument(
			[node("c1", { href: "/web/conversations/c1" }), otherBox, box, otherSend, send],
			"",
		);
		readyThread(doc, "c1", "Ada");
		const sent = (await evaluateMessagesAction(doc, "send", {
			confirmed: true,
			conversationId: "c1",
			recipient: "Ada",
			text: "hello there",
			draftId: "d1",
		})) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect((box as { nativeValue?: string }).nativeValue).toBe("hello there");
		expect((otherBox as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
		expect(doc.clicks).toContain("Send");
		expect(doc.clicks).not.toContain("Send message");
		const stray = createDocument(
			[
				node("c1", { href: "/web/conversations/c1" }),
				otherBox,
				node("Send", { "aria-label": "Send" }),
			],
			"",
		);
		(stray.clicks as unknown[]).length = 0;
		const straySend = stray.querySelectorAll("*")[2] as { paneId?: string };
		straySend.paneId = "other";
		readyThread(stray, "c1", "Ada");
		await expect(
			evaluateMessagesAction(stray, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hello there",
				draftId: "d1",
			}),
		).rejects.toThrow("compose box missing");
		expect(stray.clicks).not.toContain("Send");
	});

	test("send waits for the thread to open and does not wait past the timeout", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		const link = node("c1", { href: "/web/conversations/c1" });
		const waiting = createDocument(
			[link, box, send],
			"",
		) as ReturnType<typeof createDocument> & {
			location: { href: string };
			threadHeader: string;
			pane?: string;
			sleep?: () => void;
		};
		waiting.location = { href: "https://messages.google.com/web/u/0/" };
		waiting.threadHeader = "";
		waiting.pane = "pane-old";
		let slept = 0;
		waiting.sleep = () => {
			slept += 1;
			waiting.location = { href: "https://messages.google.com/web/u/0/conversations/c1" };
			waiting.threadHeader = "Ada";
			waiting.pane = "pane-c1";
			link.attrs["aria-selected"] = "true";
		};
		const sent = (await evaluateMessagesAction(waiting, "send", {
			confirmed: true,
			conversationId: "c1",
			recipient: "Ada",
			text: "hello there",
			draftId: "d1",
			timeoutMs: 200,
		})) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(slept).toBeGreaterThan(0);
	});

	test("the open timeout defaults to 10 seconds for missing and invalid values", () => {
		expect(resolveOpenTimeout(undefined)).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout(Number.NaN)).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout(0)).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout(-5)).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout("10")).toBe(DEFAULT_OPEN_TIMEOUT_MS);
		expect(resolveOpenTimeout(250)).toBe(250);
		expect(DEFAULT_OPEN_TIMEOUT_MS).toBe(10_000);
	});

	test("the open wait stops when the budget is spent", async () => {
		const sleeps: number[] = [];
		const stuck = {
			href: "https://messages.google.com/web/u/0/conversations/other",
			header: "Bea",
			selectedId: "other",
			pane: "same",
		};
		await expect(
			prepareSend(
				{
					href: async () => stuck.href,
					header: async () => stuck.header,
					view: async () => stuck,
					clickConversation: async () => true,
					compose: async () => {
						throw new Error("typed");
					},
					sendControl: async () => {
						throw new Error("clicked");
					},
					sleep: async (ms) => {
						sleeps.push(ms);
						if (sleeps.length > 4) throw new Error("waited forever");
					},
				},
				{
					conversationId: "c1",
					recipient: "Ada",
					text: "hi",
					confirmed: true,
					timeoutMs: 250,
					rng: () => 0,
				},
			),
		).rejects.toThrow("open conversation timed out");
		expect(sleeps).toEqual([200, 50]);
		expect(sleeps.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThanOrEqual(250);
	});

	test("conversation id 12 does not match a thread whose id is 123", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "12";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "12";
		const doc = createDocument(
			[node("12", { href: "/web/conversations/12" }), box, send],
			"",
		) as ReturnType<typeof createDocument> & { location: { href: string }; threadHeader: string };
		doc.location = { href: "https://messages.google.com/web/u/0/conversations/123" };
		doc.threadHeader = "Ada";
		await expect(
			evaluateMessagesAction(doc, "send", {
				confirmed: true,
				conversationId: "12",
				recipient: "Ada",
				text: "hello there",
				draftId: "d1",
				timeoutMs: 1,
			}),
		).rejects.toThrow("open conversation timed out");
		expect((box as { usedNativeSetter?: boolean }).usedNativeSetter).not.toBe(true);
		expect(doc.clicks).not.toContain("Send");
	});

	test("send refuses a missing thread, a missing Send control, and a disabled button", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const missingThread = createDocument([box], "");
		readyThread(missingThread, "c1", "Ada");
		await expect(
			evaluateMessagesAction(missingThread, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hi",
				draftId: "d1",
			}),
		).rejects.toThrow("conversation not found");
		const blankRecipient = createDocument(
			[node("c1", { href: "/web/conversations/c1" }), box],
			"",
		);
		readyThread(blankRecipient, "c1", "Ada");
		await expect(
			evaluateMessagesAction(blankRecipient, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "",
				text: "hi",
				draftId: "d1",
			}),
		).rejects.toThrow("conversation not found");
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		(send as { disabled?: boolean }).disabled = true;
		const disabled = createDocument(
			[node("c1", { href: "/web/conversations/c1" }), box, send],
			"",
		);
		readyThread(disabled, "c1", "Ada");
		await expect(
			evaluateMessagesAction(disabled, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hi",
				draftId: "d1",
			}),
		).rejects.toThrow("send control disabled");
		expect(disabled.clicks).not.toContain("Send");
		const noSend = createDocument(
			[node("c1", { href: "/web/conversations/c1" }), box],
			"",
		);
		readyThread(noSend, "c1", "Ada");
		await expect(
			evaluateMessagesAction(noSend, "send", {
				confirmed: true,
				conversationId: "c1",
				recipient: "Ada",
				text: "hi",
				draftId: "d1",
			}),
		).rejects.toThrow("send control missing");
	});

	test("delete is refused and send waits for confirmation", async () => {
		const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
		box.paneId = "c1";
		const send = node("Send", { "aria-label": "Send" });
		send.paneId = "c1";
		const doc = createDocument(
			[node("Delete"), node("c1", { href: "/web/conversations/c1" }), box, send],
			"",
		);
		readyThread(doc, "c1", "Ada");
		expect(() => evaluateMessagesAction(doc, "delete", {})).toThrow("delete is disabled");
		expect(doc.clicks).toEqual([]);
		await expect(
			evaluateMessagesAction(doc, "send", { confirmed: false, text: "hi", conversationId: "c1", recipient: "Ada" }),
		).rejects.toThrow("send requires confirmation");
		expect(doc.clicks).toEqual([]);
		const sent = (await evaluateMessagesAction(doc, "send", {
			confirmed: true,
			conversationId: "c1",
			recipient: "Ada",
			text: "hi",
			draftId: "d1",
		})) as { reason: string };
		expect(sent.reason).toBe("sent");
		expect(doc.clicks).toContain("Send");
		expect(doc.clicks).not.toContain("Delete");
	});
});
