/** The background's one socket and message listener, under test control. */

import { mock } from "bun:test";
import { CHAT_DEFAULT_PORT, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { registerChat } from "@/lib/background/chat";
import { MSG } from "@/lib/chat-messages";

export type Listener = (
	msg: unknown,
	sender: unknown,
	sendResponse: (r: unknown) => void,
) => boolean | undefined;

export type FakeSocket = {
	send: ReturnType<typeof mock>;
	addEventListener: ReturnType<typeof mock>;
	dispatch(type: string, event?: unknown): void;
};

export function makeFakeSocket(): FakeSocket {
	const listeners: Record<string, Array<(event?: unknown) => void>> = {};
	return {
		send: mock((_data: string) => undefined),
		addEventListener: mock((type: string, cb: (event?: unknown) => void) => {
			if (!listeners[type]) listeners[type] = [];
			listeners[type].push(cb);
		}),
		dispatch(type: string, event?: unknown) {
			for (const cb of listeners[type] ?? []) cb(event);
		},
	};
}

export function frameEvent(frame: Record<string, unknown>) {
	return { data: JSON.stringify(frame) };
}

const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

export type BootRelayOptions = {
	confirmSession?: boolean;
	sessionId?: string;
	token?: string;
};

export type BootedRelay = {
	socket: FakeSocket;
	posted: unknown[];
	postAs(senderUrl: string, message: unknown): Promise<unknown>;
	postAsOptionsPage(message: unknown): Promise<unknown>;
	postAsChatPage(message: unknown): Promise<unknown>;
	extensionUrl(path: string): string;
	sessionId: string;
	token: string;
	sentFrames(): Record<string, unknown>[];
};

/** Boots a real registerChat over a fake socket, so posts carry exactly what a page would send. */
export async function bootRelay(
	options: BootRelayOptions = {},
): Promise<BootedRelay> {
	const sessionId = options.sessionId ?? "sess-abc123";
	const token = options.token ?? "tok-super-secret-xyz789";
	const socket = makeFakeSocket();
	let onMessage: Listener | undefined;
	const posted: unknown[] = [];
	const api = {
		action: { onClicked: { addListener: mock(() => undefined) } },
		runtime: {
			onMessage: {
				addListener: mock((cb: Listener) => {
					onMessage = cb;
				}),
			},
			getURL: mock((path: string) => `chrome-extension://test-ext/${path}`),
			sendMessage: mock((_m: unknown) => Promise.resolve(undefined)),
		},
		tabs: { create: mock(() => Promise.resolve()) },
		storage: { session: { set: mock(() => Promise.resolve()) } },
	};
	registerChat({
		browserApi: api,
		openSocket: () => socket,
		maybeStartRecording: () => Promise.resolve(false),
	});

	function postAs(senderUrl: string, message: unknown): Promise<unknown> {
		posted.push(message);
		return new Promise((resolve) => {
			const kept = onMessage?.(message, { url: senderUrl }, resolve);
			if (!kept) resolve(undefined);
		});
	}

	onMessage?.(
		{
			type: MSG.markerCaptured,
			bootstrap: {
				port: CHAT_DEFAULT_PORT,
				sessionId,
				token,
				agentIdentity: "claude-orchestrator",
			},
		},
		{},
		mock(() => undefined),
	);
	await settle();
	socket.dispatch("open");
	await settle();
	if (options.confirmSession !== false) {
		socket.dispatch(
			"message",
			frameEvent({
				type: "session-list",
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				sessions: [],
			}),
		);
		await settle();
	}

	return {
		socket,
		posted,
		postAs,
		postAsOptionsPage: (message) =>
			postAs(api.runtime.getURL("options.html"), message),
		postAsChatPage: (message) =>
			postAs(api.runtime.getURL("chat.html"), message),
		extensionUrl: (path) => api.runtime.getURL(path),
		sessionId,
		token,
		sentFrames: () =>
			socket.send.mock.calls.map(
				([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
			),
	};
}
