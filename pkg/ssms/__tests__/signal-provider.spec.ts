import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSignalProvider } from "../src/signal/provider";
import { connectJsonRpc } from "../src/signal/rpc";
import { writeIndex } from "../src/signal/journal";
import { resolveSignalBinary, signalCliInstallHint } from "../src/signal/hint";
import { startFakeSignalServer } from "./support/rpc";

describe("signal provider", () => {
	test("link prints the URI through the callback before finishLink and names the device dg-cli", async () => {
		const order: string[] = [];
		const server = await startFakeSignalServer((method, params) => {
			order.push(method);
			if (method === "startLink") {
				expect(params).toEqual({});
				return { deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY" };
			}
			if (method === "finishLink") return { aci: "acct-1", number: "+15555550123" };
			throw new Error(method);
		});
		const rpc = await connectJsonRpc(server.port);
		const home = mkdtempSync(join(tmpdir(), "ssms-link-"));
		const provider = createSignalProvider({ home, rpc, ids: () => "d1", now: () => 0 });
		const seen: string[] = [];
		const result = await provider.link({
			onUri: (uri) => {
				order.push("uri");
				seen.push(uri);
			},
		});
		expect(order).toEqual(["startLink", "uri", "finishLink"]);
		expect(seen).toEqual(["sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY"]);
		expect(server.calls[1]?.params).toEqual({
			deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY",
			deviceName: "dg-cli",
		});
		expect(result.accountId).toBe("acct-1");
		expect(JSON.stringify(result)).not.toContain("+15555550123");
		await rpc.close();
		await server.close();
	});

	test("send uses send, sendReaction, attachments, and quotes without a phone number", async () => {
		const server = await startFakeSignalServer((method) => {
			if (method === "send" || method === "sendReaction") return { timestamp: 1 };
			throw new Error(method);
		});
		const rpc = await connectJsonRpc(server.port);
		const home = mkdtempSync(join(tmpdir(), "ssms-send-"));
		const image = join(home, "pic.jpg");
		writeFileSync(image, "jpeg");
		writeIndex(home, [
			{
				id: "g1",
				title: "Family",
				preview: "",
				pinned: false,
				savedContact: false,
				ageDays: 0,
				kind: "group",
			},
		]);
		const provider = createSignalProvider({
			home,
			rpc,
			accountId: "acct-1",
			ids: (() => {
				let n = 0;
				return () => `d${++n}`;
			})(),
			now: () => 0,
		});
		const text = await provider.draftReply({ conversationId: "u2", text: "hello" });
		await provider.sendDraft({ draftId: text.id, confirmed: true, hook: false });
		const reaction = await provider.draftReply({
			conversationId: "u2",
			emoji: "👍",
			targetTimestamp: 10,
			targetAuthorId: "u3",
		});
		await provider.sendDraft({ draftId: reaction.id, confirmed: true, hook: false });
		const imageDraft = await provider.draftReply({
			conversationId: "g1",
			text: "pic",
			attachments: [{ path: image, contentType: "image/jpeg" }],
			quote: { authorId: "u3", timestamp: 9, text: "earlier" },
		});
		await provider.sendDraft({ draftId: imageDraft.id, confirmed: true, hook: false });
		expect(server.calls.map((call) => call.method)).toEqual(["send", "sendReaction", "send"]);
		expect(server.calls[0]?.params).toEqual({
			account: "acct-1",
			recipient: ["u2"],
			message: "hello",
			attachment: [],
		});
		expect(server.calls[1]?.params).toEqual({
			account: "acct-1",
			recipient: ["u2"],
			emoji: "👍",
			targetAuthor: "u3",
			targetTimestamp: 10,
			remove: false,
		});
		expect(server.calls[2]?.params).toEqual({
			account: "acct-1",
			groupId: "g1",
			message: "pic",
			attachment: [image],
			quoteTimestamp: 9,
			quoteAuthor: "u3",
			quoteMessage: "earlier",
		});
		expect(JSON.stringify(server.calls)).not.toContain("+1555");
		await rpc.close();
		await server.close();
	});

	test("receive stores messages and asks signal-cli for a jittered timeout", async () => {
		const server = await startFakeSignalServer(() => [
			{
				envelope: {
					sourceUuid: "u2",
					sourceNumber: "+15555550123",
					dataMessage: {
						timestamp: 4,
						message: "secret-body",
						attachments: [{ id: "a1", contentType: "image/png", size: 4 }],
						quote: { id: 3, authorUuid: "u9", text: "earlier" },
					},
				},
			},
		]);
		const rpc = await connectJsonRpc(server.port);
		const home = mkdtempSync(join(tmpdir(), "ssms-recv-"));
		const provider = createSignalProvider({
			home,
			rpc,
			accountId: "acct-1",
			rng: () => 0.95,
			now: () => 0,
		});
		const messages = await provider.receive({ limit: 5, timeoutMs: 0 });
		expect(messages[0]?.text).toBe("secret-body");
		expect(messages[0]?.attachments[0]?.contentType).toBe("image/png");
		expect(messages[0]?.quote?.timestamp).toBe(3);
		expect(JSON.stringify(messages)).not.toContain("+15555550123");
		expect(server.calls[0]?.params).toMatchObject({ account: "acct-1", maxMessages: 5 });
		const timeout = (server.calls[0]?.params as { timeout: number }).timeout;
		expect(timeout).toBeGreaterThan(1);
		const again = createSignalProvider({
			home,
			rpc,
			accountId: "acct-1",
			rng: () => 0,
			now: () => 0,
		});
		await again.receive({ limit: 1, timeoutMs: 0 });
		const second = (server.calls[1]?.params as { timeout: number }).timeout;
		expect(second).not.toBe(timeout);
		await rpc.close();
		await server.close();
	});
});

describe("attachment approval", () => {
	test("send refuses an attachment whose bytes changed after the draft", async () => {
		const server = await startFakeSignalServer((method) => {
			if (method === "send") return { timestamp: 1 };
			throw new Error(method);
		});
		const rpc = await connectJsonRpc(server.port);
		const home = mkdtempSync(join(tmpdir(), "ssms-hash-"));
		const image = join(home, "pic.jpg");
		writeFileSync(image, "jpeg-approved");
		const provider = createSignalProvider({
			home,
			rpc,
			accountId: "acct-1",
			ids: () => "d1",
			now: () => 0,
		});
		const draft = await provider.draftReply({
			conversationId: "u2",
			text: "pic",
			attachments: [{ path: image, contentType: "image/jpeg" }],
		});
		writeFileSync(image, "jpeg-replaced");
		await expect(
			provider.sendDraft({ draftId: draft.id, confirmed: true, hook: false }),
		).rejects.toThrow(/changed/);
		expect(server.calls.filter((call) => call.method === "send")).toEqual([]);
		await rpc.close();
		await server.close();
	});
});

describe("signal-cli install hint", () => {
	test("names the Arch package and does not pretend to install it", () => {
		const hint = signalCliInstallHint();
		expect(hint).toContain("signal-cli is not installed");
		expect(hint).toContain("sudo pacman -S signal-cli");
		expect(hint).toContain("will not install");
		expect(() => resolveSignalBinary({}, () => null, () => false)).toThrow(hint);
		expect(() => resolveSignalBinary({ DG_SIGNAL_CLI: "/missing/signal-cli" }, () => "/usr/bin/signal-cli", () => false)).toThrow(
			hint,
		);
		expect(resolveSignalBinary({ DG_SIGNAL_CLI: "/usr/bin/signal-cli" }, () => null, () => true)).toBe(
			"/usr/bin/signal-cli",
		);
	});
});
