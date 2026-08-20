/** Slice 12's integration wiring: the chat page's command dispatch reaching the daemon. */

import { describe, expect, it, mock } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateChatFrame } from "@dg/common";

mock.module("wxt/browser", () => ({ browser: {} }));

const { bootRelay } = await import("./utils/relay-harness");
const { MSG } = await import("@/lib/chat-messages");

const SESSION_ID = "sess-abc123";
const TOKEN = "tok-super-secret-xyz789";

function invocationFrames(
	frames: Record<string, unknown>[],
): Record<string, unknown>[] {
	return frames.filter((f) => f.type === "command-invocation");
}

describe("command dispatch relays through the background, which owns the token", () => {
	it("puts a real command-invocation frame on the socket carrying that session's own token", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		const reply = await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: "$review",
			params: { scope: "diff" },
		});

		expect(reply).toEqual({ ok: true });
		const [frame] = invocationFrames(relay.sentFrames());
		expect(frame).toBeDefined();
		expect(frame?.sessionId).toBe(SESSION_ID);
		expect(frame?.token).toBe(TOKEN);
		expect(frame?.commandLabel).toBe("$review");
		expect(frame?.params).toEqual({ scope: "diff" });
		expect(frame?.protocolVersion).toBe(CHAT_PROTOCOL_VERSION);
	});

	it("sends a frame the ratified validator accepts, not an ad-hoc shape the daemon would reject", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: "$review",
			params: {},
		});

		const [frame] = invocationFrames(relay.sentFrames());
		expect(() => validateChatFrame(frame)).not.toThrow();
	});

	it("never requires the page to hold a token — what the page posts carries none", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: "$review",
			params: {},
		});

		const posted = JSON.stringify(relay.posted);
		expect(posted).not.toContain(TOKEN);
		expect(invocationFrames(relay.sentFrames()).length).toBe(1);
	});

	it("refuses a content-script sender outright, so a page in the wild cannot dispatch a command", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		await relay.postAs("https://evil.example/page.html", {
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: "$review",
			params: {},
		});

		expect(invocationFrames(relay.sentFrames())).toEqual([]);
	});

	it("refuses a session it holds no bootstrap for, rather than dispatching under another session's token", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		const reply = await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: "sess-not-ours",
			commandLabel: "$review",
			params: {},
		});

		expect(invocationFrames(relay.sentFrames())).toEqual([]);
		expect((reply as { ok: boolean }).ok).toBe(false);
	});

	it("refuses a non-string commandLabel and an empty one, so a malformed dispatch never reaches the daemon", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: { toString: () => "$review" },
			params: {},
		});
		await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: "",
			params: {},
		});

		expect(invocationFrames(relay.sentFrames())).toEqual([]);
	});

	it("defaults params to an empty object rather than forwarding a non-object the daemon would reject", async () => {
		const relay = await bootRelay({ sessionId: SESSION_ID, token: TOKEN });

		await relay.postAsChatPage({
			type: MSG.commandInvocation,
			sessionId: SESSION_ID,
			commandLabel: "$review",
			params: "not-an-object",
		});

		const [frame] = invocationFrames(relay.sentFrames());
		expect(frame?.params).toEqual({});
	});
});
