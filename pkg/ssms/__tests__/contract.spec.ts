import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsupportedCapability } from "../src/errors";
import { createLocalMessagesBrowser } from "../src/google/browser";
import { createGoogleProvider } from "../src/google/provider";
import { appendJournal } from "../src/signal/journal";
import { createSignalProvider } from "../src/signal/provider";
import { connectJsonRpc } from "../src/signal/rpc";
import type { SmsCapability, SmsProvider } from "../src/types";
import { asTextArea, createDocument, node, readyThread } from "./support/document";
import { startFakeSignalServer, type RpcCall } from "./support/rpc";

interface Fixture {
	provider: SmsProvider;
	logs: string[];
	sent: () => number;
	close: () => Promise<void>;
}

async function googleFixture(): Promise<Fixture> {
	const home = mkdtempSync(join(tmpdir(), "ssms-google-"));
	const logs: string[] = [];
	const sent = { n: 0 };
	const doc = createDocument(
		[
			node("Load more conversations"),
			node("secret-body", { href: "/web/conversations/c1", "aria-label": "Ada" }),
			node("other", { href: "/web/conversations/c2", "aria-label": "Bea" }),
			node("secret-body", { id: "m1", datetime: "1", "aria-label": "ada" }, "MWS-MESSAGE-WRAPPER"),
			node("second", { id: "m2", datetime: "2", "aria-label": "ada" }, "MWS-MESSAGE-WRAPPER"),
			node("third", { id: "m3", datetime: "3", "aria-label": "ada" }, "MWS-MESSAGE-WRAPPER"),
			node("Options"),
			node("Archive"),
			node("Details"),
			node("Block & report spam"),
			node("Delete"),
			(() => {
				const send = node("Send", { "aria-label": "Send" });
				send.paneId = "c1";
				return send;
			})(),
			(() => {
				const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
				box.paneId = "c1";
				return box;
			})(),
		],
		"Conversations",
	);
	readyThread(doc, "c1", "Ada");
	const browser = createLocalMessagesBrowser(doc, async () => undefined);
	const real = browser.act.bind(browser);
	browser.act = async (action, args) => {
		if (action === "send") sent.n += 1;
		return real(action, args);
	};
	return {
		provider: createGoogleProvider({
			browser,
			home,
			log: (event) => logs.push(JSON.stringify(event)),
			ids: () => "draft-google",
			now: () => 0,
		}),
		logs,
		sent: () => sent.n,
		close: async () => undefined,
	};
}

async function signalFixture(): Promise<Fixture> {
	const home = mkdtempSync(join(tmpdir(), "ssms-signal-"));
	const logs: string[] = [];
	appendJournal(home, [
		{
			id: "m1",
			conversationId: "c1",
			timestamp: 1,
			direction: "in",
			senderId: "u2",
			text: "secret-body",
			attachments: [],
		},
		{
			id: "m2",
			conversationId: "c1",
			timestamp: 2,
			direction: "in",
			senderId: "u2",
			text: "second",
			attachments: [],
		},
		{
			id: "m3",
			conversationId: "c1",
			timestamp: 3,
			direction: "in",
			senderId: "u2",
			text: "third",
			attachments: [],
		},
	]);
	const server = await startFakeSignalServer((method, params) => {
		if (method === "startLink") return { deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY" };
		if (method === "finishLink") return { aci: "acct-1", number: "+15555550123" };
		if (method === "listAccounts") return [{ aci: "acct-1", number: "+15555550123" }];
		if (method === "listContacts") {
			return [
				{ uuid: "c1", number: "+15555550123", name: "Ada" },
				{ uuid: "c2", number: "+15555550124", name: "Bea" },
			];
		}
		if (method === "listGroups") return [];
		if (method === "send" || method === "sendReaction") return { timestamp: 9 };
		if (method === "receive") {
			return [
				{
					envelope: {
						sourceNumber: "+15555550123",
						sourceUuid: "u2",
						dataMessage: { timestamp: 8, message: "secret-body" },
					},
				},
			];
		}
		throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
	});
	const rpc = await connectJsonRpc(server.port);
	return {
		provider: createSignalProvider({
			home,
			rpc,
			accountId: "acct-1",
			log: (event) => logs.push(JSON.stringify(event)),
			ids: () => "draft-signal",
			now: () => 0,
			rng: () => 0,
		}),
		logs,
		sent: () => server.calls.filter((call: RpcCall) => call.method === "send" || call.method === "sendReaction").length,
		close: async () => {
			await rpc.close();
			await server.close();
		},
	};
}

const unsupportedCall: Record<SmsCapability, (provider: SmsProvider) => Promise<unknown>> = {
	link: (provider) => provider.link({}),
	status: (provider) => provider.status(),
	listConversations: (provider) => provider.listConversations(),
	readRecent: (provider) => provider.readRecent("c1", 1),
	receive: (provider) => provider.receive({ limit: 1, timeoutMs: 0 }),
	archive: (provider) => provider.archive({ conversationId: "c1" }),
	blockAndReportSpam: (provider) => provider.blockAndReportSpam({ conversationId: "c1" }),
	draftReply: (provider) => provider.draftReply({ conversationId: "c1", text: "hi" }),
	sendDraft: (provider) => provider.sendDraft({ draftId: "missing", confirmed: true, hook: false }),
	reactions: (provider) =>
		provider.draftReply({
			conversationId: "c1",
			emoji: "👍",
			targetTimestamp: 1,
			targetAuthorId: "ada",
		}),
	attachments: (provider) =>
		provider.draftReply({
			conversationId: "c1",
			attachments: [{ path: "/tmp/a.jpg", contentType: "image/jpeg" }],
		}),
	quotes: (provider) =>
		provider.draftReply({
			conversationId: "c1",
			text: "re",
			quote: { authorId: "ada", timestamp: 1, text: "q" },
		}),
};

async function assertContract(name: string, open: () => Promise<Fixture>) {
	test(`${name} reports every capability as a boolean`, async () => {
		const fixture = await open();
		try {
			for (const value of Object.values(fixture.provider.capabilities)) expect(typeof value).toBe("boolean");
			expect(Object.keys(fixture.provider.capabilities).sort()).toEqual(Object.keys(unsupportedCall).sort());
		} finally {
			await fixture.close();
		}
	});

	test(`${name} refuses each capability it does not implement`, async () => {
		const fixture = await open();
		try {
			const calls = Object.entries(unsupportedCall) as [
				SmsCapability,
				(provider: SmsProvider) => Promise<unknown>,
			][];
			for (const [capability, call] of calls) {
				if (fixture.provider.capabilities[capability]) continue;
				try {
					await call(fixture.provider);
					throw new Error(`expected ${capability} to throw`);
				} catch (error) {
					expect(error).toBeInstanceOf(UnsupportedCapability);
					expect((error as UnsupportedCapability).capability).toBe(capability);
					expect((error as Error).message).toBe(`${fixture.provider.id} does not support ${capability}`);
				}
			}
		} finally {
			await fixture.close();
		}
	});

	test(`${name} lists conversations and reads the newest messages`, async () => {
		const fixture = await open();
		try {
			const rows = await fixture.provider.listConversations();
			expect(rows.map((row) => row.id)).toEqual(["c1", "c2"]);
			expect(await fixture.provider.readRecent("c1", 0)).toEqual([]);
			const newest = await fixture.provider.readRecent("c1", 1);
			expect(newest.map((item) => item.id)).toEqual(["m3"]);
			const two = await fixture.provider.readRecent("c1", 2);
			expect(two.map((item) => item.id)).toEqual(["m3", "m2"]);
		} finally {
			await fixture.close();
		}
	});

	test(`${name} drafts without sending, and sends only a confirmed draft`, async () => {
		const fixture = await open();
		try {
			const before = fixture.sent();
			const draft = await fixture.provider.draftReply({ conversationId: "c1", text: "hello" });
			expect(draft.status).toBe("pending");
			if (name === "google") expect(draft.recipient).toBe("Ada");
			expect(fixture.sent()).toBe(before);
			await expect(
				fixture.provider.sendDraft({ draftId: draft.id, confirmed: false, hook: false }),
			).rejects.toThrow("interactive yes");
			expect(fixture.sent()).toBe(before);
			await expect(
				fixture.provider.sendDraft({ draftId: draft.id, confirmed: true, hook: true }),
			).rejects.toThrow("hook");
			expect(fixture.sent()).toBe(before);
			const sent = await fixture.provider.sendDraft({
				draftId: draft.id,
				confirmed: true,
				hook: false,
			});
			expect(sent).toEqual({ draftId: draft.id, reason: "sent" });
			expect(fixture.sent()).toBe(before + 1);
		} finally {
			await fixture.close();
		}
	});

	test(`${name} logs ids and reasons without phones, linking URIs, or message bodies`, async () => {
		const fixture = await open();
		try {
			await fixture.provider.link({});
			await fixture.provider.readRecent("c1", 2);
			await fixture.provider.receive({ limit: 1, timeoutMs: 0 });
			const blob = fixture.logs.join("\n");
			expect(blob).not.toContain("secret-body");
			expect(blob).not.toContain("+1555555");
			expect(blob).not.toContain("sgnl://");
			expect(blob).not.toContain("SECRETKEY");
			expect(blob.length).toBeGreaterThan(0);
		} finally {
			await fixture.close();
		}
	});
}

describe("provider contract", () => {
	describe("google", () => {
		void assertContract("google", googleFixture);
	});
	describe("signal", () => {
		void assertContract("signal", signalFixture);
	});
});
