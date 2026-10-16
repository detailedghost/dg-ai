import { expect, spyOn, test } from "bun:test";
import { CHAT_DEFAULT_PORT, type SessionBootstrap } from "@dg/common";
import { createChatClient } from "@/lib/features/chat-client";

const TOKEN = "extension-drop-token-must-stay-out";

function fakeSocket() {
	const listeners: Record<string, Array<(event?: unknown) => void>> = {};
	return {
		send() {},
		addEventListener(type: string, cb: (event?: unknown) => void) {
			listeners[type] ??= [];
			listeners[type].push(cb);
		},
		dispatch(type: string) {
			for (const listener of listeners[type] ?? []) listener();
		},
	};
}

test("a socket close logs a connection drop without the session token", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		const socket = fakeSocket();
		const client = createChatClient({
			openSocket: () => socket,
			keepaliveIntervalMs: 20_000,
		});
		const bootstrap: SessionBootstrap = {
			port: CHAT_DEFAULT_PORT,
			sessionId: "22222222-2222-4222-8222-222222222222",
			token: TOKEN,
			agentIdentity: "claude",
		};
		client.connect(bootstrap);
		socket.dispatch("close");
		const text = warn.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(text).toContain('"phase":"dropped"');
		expect(text).toContain("22222222[redacted]");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain("22222222-2222-4222-8222-222222222222");
		expect(text).toContain('"keepaliveMs":20000');
	} finally {
		warn.mockRestore();
	}
});
