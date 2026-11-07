import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
} from "@dg/common";
import { Window } from "happy-dom";
import {
	type ChatClient,
	type ChatClientSocket,
	type ChatConnectionState,
	createChatClient,
} from "../src/chat/chat-client";
import { SESSION_ENDED_TEXT } from "../src/local";
import { exchangeReply, pageFragment } from "./utils/page-code";

const BOOTSTRAP: SessionBootstrap = {
	port: 47823,
	sessionId: "0123abcd-ef01-4567-89ab-cdef01234567",
	token: "tok/a+b=",
	agentIdentity: "claude-js",
};
const NOT_DELIVERED_TEXT =
	"The daemon did not confirm this message. Check that the agent is running.";
const ACK_TIMEOUT_MS = 5000;
const ALLOWED_STATES: readonly ChatConnectionState[] = [
	"connected",
	"reconnecting",
	"daemon-not-running",
];

type ConfirmingClient = ChatClient & {
	isSessionConfirmed(sessionId: string): boolean;
	sendUserMessageAndWait(
		sessionId: string,
		body: string,
		opts?: { timeoutMs?: number; messageId?: string },
	): Promise<{ ok: true } | { ok: false; reason?: string; error?: string }>;
};

function frame(type: string, extra: Record<string, unknown> = {}) {
	return {
		type,
		sessionId: BOOTSTRAP.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...extra,
	};
}

function sessionList(
	presence?: string,
	sessionId: string = BOOTSTRAP.sessionId,
) {
	return frame("session-list", {
		sessions: [
			{
				sessionId,
				agentIdentity: BOOTSTRAP.agentIdentity,
				role: "agent",
				...(presence === undefined ? {} : { presence }),
			},
		],
	});
}

type Listener = (event?: unknown) => void;

type TestSocket = ChatClientSocket & {
	sent: Record<string, unknown>[];
	fire(type: "open" | "close" | "error"): void;
	receive(payload: Record<string, unknown>): void;
};

function makeSocket(): TestSocket {
	const listeners = new Map<string, Listener[]>();
	const sent: Record<string, unknown>[] = [];
	const emit = (type: string, event?: unknown) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	return {
		sent,
		send: (data) => {
			sent.push(JSON.parse(data));
		},
		addEventListener: (type, listener) => {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		fire: (type) => emit(type),
		receive: (payload) =>
			emit("message", { data: JSON.stringify(payload) }),
	};
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = (() =>
		Promise.reject(new TypeError("no daemon"))) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function newClient(
	options: Parameters<typeof createChatClient>[0] = {},
): { client: ConfirmingClient; sockets: TestSocket[]; states: string[] } {
	const sockets: TestSocket[] = [];
	const states: string[] = [];
	const client = createChatClient({
		openSocket: () => {
			const socket = makeSocket();
			sockets.push(socket);
			return socket;
		},
		backoffBaseMs: 1,
		randomJitter: () => 0,
		...options,
	}) as ConfirmingClient;
	client.onConnectionChange((state) => states.push(state));
	return { client, sockets, states };
}

async function until<T>(
	check: () => T | undefined,
	label: string,
): Promise<T> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		const value = check();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageFrame(socket: TestSocket) {
	return socket.sent.find((entry) => entry.type === "user-message");
}

describe("chat client session confirmation (H4: connected on socket open)", () => {
	test("H4: an open socket whose connect handshake has no session-list yet is not a confirmed session", async () => {
		const { client, sockets } = newClient();
		client.connect(BOOTSTRAP);

		sockets[0]?.fire("open");

		await until(
			() => sockets[0]?.sent.find((entry) => entry.type === "connect"),
			"the connect frame",
		);
		expect(client.isSessionConfirmed(BOOTSTRAP.sessionId)).toBe(false);
	});

	test("confirms the live session once a session-list on this socket includes it", () => {
		const { client, sockets } = newClient();
		client.connect(BOOTSTRAP);
		sockets[0]?.fire("open");

		sockets[0]?.receive(sessionList("cli"));

		expect(client.isSessionConfirmed(BOOTSTRAP.sessionId)).toBe(true);
	});

	test("does not confirm the live session from a session-list that omits it", () => {
		const { client, sockets } = newClient();
		client.connect(BOOTSTRAP);
		sockets[0]?.fire("open");

		sockets[0]?.receive(sessionList("cli", "some-other-session"));

		expect(client.isSessionConfirmed(BOOTSTRAP.sessionId)).toBe(false);
	});

	test("clears the confirmation on socket close and stays unconfirmed on the next socket until its session-list", async () => {
		const { client, sockets } = newClient();
		client.connect(BOOTSTRAP);
		sockets[0]?.fire("open");
		sockets[0]?.receive(sessionList("cli"));

		sockets[0]?.fire("close");
		expect(client.isSessionConfirmed(BOOTSTRAP.sessionId)).toBe(false);

		const second = await until(() => sockets[1], "the reconnect socket");
		second.fire("open");
		await until(
			() => second.sent.find((entry) => entry.type === "connect"),
			"the connect frame on the reconnect socket",
		);
		expect(client.isSessionConfirmed(BOOTSTRAP.sessionId)).toBe(false);

		second.receive(sessionList("cli"));
		expect(client.isSessionConfirmed(BOOTSTRAP.sessionId)).toBe(true);
	});

	test("confirms a session created by New chat on session-pending even though its session-list came first", async () => {
		const { client, sockets } = newClient();
		client.connect(BOOTSTRAP);
		sockets[0]?.fire("open");
		sockets[0]?.receive(sessionList("cli"));
		sockets[0]?.receive(sessionList("cli", "session-b"));

		sockets[0]?.receive(
			frame("session-pending", {
				newSession: { sessionId: "session-b", token: "tok-b" },
			}),
		);
		client.sendUserMessage("session-b", "hello");

		expect(client.isSessionConfirmed("session-b")).toBe(true);
		await until(
			() =>
				sockets[0]?.sent.find(
					(entry) =>
						entry.type === "user-message" && entry.sessionId === "session-b",
				),
			"the user-message frame for the new session",
		);
	});

	test("never emits a connection state outside the exported ChatConnectionState union", () => {
		const { client, sockets, states } = newClient({ backoffBaseMs: 60_000 });
		client.connect(BOOTSTRAP);
		sockets[0]?.fire("open");
		sockets[0]?.receive(sessionList("cli"));
		sockets[0]?.fire("close");

		expect(states.length).toBeGreaterThan(0);
		for (const state of states) {
			expect(ALLOWED_STATES).toContain(state as ChatConnectionState);
		}
	});
});

describe("chat client ack wait", () => {
	function confirmed() {
		const harness = newClient({ backoffBaseMs: 60_000 });
		harness.client.connect(BOOTSTRAP);
		harness.sockets[0]?.fire("open");
		harness.sockets[0]?.receive(sessionList("cli"));
		return harness;
	}

	test("resolves ok when the ack for the sent messageId arrives in time", async () => {
		const { client, sockets } = confirmed();

		const result = client.sendUserMessageAndWait(BOOTSTRAP.sessionId, "hello", {
			timeoutMs: 500,
		});
		const written = await until(
			() => (sockets[0] ? messageFrame(sockets[0]) : undefined),
			"the user-message frame",
		);
		sockets[0]?.receive(frame("ack", { messageId: written.messageId }));

		expect(await result).toEqual({ ok: true });
	});

	test("resolves not ok with reason timeout when no ack arrives within timeoutMs", async () => {
		const { client } = confirmed();

		const result = await client.sendUserMessageAndWait(
			BOOTSTRAP.sessionId,
			"hello",
			{ timeoutMs: 30 },
		);

		expect(result).toMatchObject({ ok: false, reason: "timeout" });
	});

	test("ignores an ack for a messageId it never sent", async () => {
		const { client, sockets } = confirmed();
		const result = client.sendUserMessageAndWait(BOOTSTRAP.sessionId, "hello", {
			timeoutMs: 60,
		});
		await until(
			() => (sockets[0] ? messageFrame(sockets[0]) : undefined),
			"the user-message frame",
		);

		sockets[0]?.receive(frame("ack", { messageId: "unknown-id" }));

		expect(await result).toMatchObject({ ok: false, reason: "timeout" });
	});

	test("does not re-send a timed out message after a reconnect confirms the session", async () => {
		const { client, sockets } = confirmed();

		const result = await client.sendUserMessageAndWait(BOOTSTRAP.sessionId, "hello", {
			timeoutMs: 30,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });

		sockets[0]?.fire("close");
		client.retryNow();
		const second = await until(() => sockets[1], "the reconnect socket");
		second.fire("open");
		second.receive(sessionList("cli"));
		await until(
			() => second.sent.find((entry) => entry.type === "connect"),
			"the connect frame on the reconnect socket",
		);
		await pause(50);

		expect(messageFrame(second)).toBeUndefined();
	});

	test("starts the timer when the frame is written, not when a message queued during a reconnect is enqueued", async () => {
		const { client, sockets } = confirmed();
		sockets[0]?.fire("close");

		const result = client.sendUserMessageAndWait(BOOTSTRAP.sessionId, "queued", {
			timeoutMs: 60,
		});
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await pause(150);
		expect(settled).toBe(false);
		expect(sockets.flatMap((s) => s.sent).some((e) => e.type === "user-message")).toBe(false);

		client.retryNow();
		const second = await until(() => sockets[1], "the reconnect socket");
		second.fire("open");
		second.receive(sessionList("cli"));
		const written = await until(() => messageFrame(second), "the queued frame");
		second.receive(frame("ack", { messageId: written.messageId }));

		expect(await result).toEqual({ ok: true });
	});

	async function writtenPending(timeoutMs: number) {
		const harness = confirmed();
		const result = harness.client.sendUserMessageAndWait(
			BOOTSTRAP.sessionId,
			"hello",
			{ timeoutMs },
		);
		await until(
			() => (harness.sockets[0] ? messageFrame(harness.sockets[0]) : undefined),
			"the user-message frame",
		);
		return { ...harness, result };
	}

	async function reconnectAndConfirm(harness: ReturnType<typeof confirmed>) {
		harness.client.retryNow();
		const next = await until(() => harness.sockets[1], "the reconnect socket");
		next.fire("open");
		next.receive(sessionList("cli"));
		return next;
	}

	test("a session-closed frame settles a pending message not ok without a timeout reason, clears its timer and sends nothing after a reconnect", async () => {
		const harness = await writtenPending(60);
		const clearedBefore: unknown[] = [];
		const realClear = globalThis.clearTimeout;
		globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
			clearedBefore.push(timer);
			return realClear(timer);
		}) as typeof clearTimeout;
		try {
			harness.sockets[0]?.receive(frame("session-closed"));
			const result = await harness.result;

			expect(result.ok).toBe(false);
			expect((result as { reason?: string }).reason).not.toBe("timeout");
			expect(clearedBefore.length).toBeGreaterThan(0);
		} finally {
			globalThis.clearTimeout = realClear;
		}

		harness.sockets[0]?.fire("close");
		await pause(100);
		expect(harness.sockets.flatMap((s) => s.sent).filter((e) => e.type === "user-message")).toHaveLength(1);
	});

	test("forgetting the session settles a pending message not ok without a timeout reason and re-sends nothing", async () => {
		const harness = await writtenPending(60);

		harness.client.forgetSession(BOOTSTRAP.sessionId);
		const result = await harness.result;

		expect(result.ok).toBe(false);
		expect((result as { reason?: string }).reason).not.toBe("timeout");
		await pause(100);
		expect(harness.sockets.flatMap((s) => s.sent).filter((e) => e.type === "user-message")).toHaveLength(1);
	});

	test("the first write owns the ack window: a re-send after a drop does not restart the timer", async () => {
		const timeoutMs = 200;
		const harness = await writtenPending(timeoutMs);
		const firstWriteAt = Date.now();
		let settledAt = 0;
		void harness.result.then(() => {
			settledAt = Date.now();
		});

		await pause(100);
		harness.sockets[0]?.fire("close");
		const second = await reconnectAndConfirm(harness);
		const resent = await until(() => messageFrame(second), "the re-sent frame");
		expect(resent.messageId).toBe(messageFrame(harness.sockets[0] as TestSocket)?.messageId);

		const result = await harness.result;

		expect(result).toMatchObject({ ok: false, reason: "timeout" });
		expect(settledAt - firstWriteAt).toBeLessThan(timeoutMs + 80);
	});
});

type Net = {
	win: Window;
	sockets: { url: string; sent: string[]; handle: FakeHandle }[];
	timeouts: { callback: () => void; ms: number }[];
};

type FakeHandle = {
	fire(type: string): void;
	receive(payload: Record<string, unknown>): void;
};

const GLOBAL_KEYS = [
	"window",
	"document",
	"WebSocket",
	"fetch",
	"setTimeout",
	"HTMLElement",
	"Node",
	"Element",
	"navigator",
	"location",
	"localStorage",
	"sessionStorage",
] as const;
const realSetTimeout = globalThis.setTimeout;
let saved: Partial<Record<(typeof GLOBAL_KEYS)[number], unknown>> = {};
let openWindow: Window | undefined;
let imports = 0;

function installPage(
	href: string,
	respond: () => Promise<Response> = () =>
		Promise.reject(new TypeError("Failed to fetch")),
): Net {
	const win = new Window({ url: href });
	openWindow = win;
	const app = win.document.createElement("div");
	app.id = "app";
	win.document.body.append(app);
	const net: Net = { win, sockets: [], timeouts: [] };
	class FakeSocket {
		static readonly OPEN = 1;
		readyState = 0;
		private listeners = new Map<string, Listener[]>();
		constructor(url: string) {
			const entry = {
				url,
				sent: [] as string[],
				handle: {
					fire: (type: string) => {
						if (type === "open") this.readyState = 1;
						if (type === "close") this.readyState = 3;
						for (const listener of this.listeners.get(type) ?? [])
							listener({ type });
					},
					receive: (payload: Record<string, unknown>) => {
						const data = JSON.stringify({
							protocolVersion: CHAT_PROTOCOL_VERSION,
							...payload,
						});
						for (const listener of this.listeners.get("message") ?? [])
							listener({ type: "message", data });
					},
				},
			};
			net.sockets.push(entry);
			this.sentRef = entry.sent;
		}
		private sentRef: string[] = [];
		addEventListener(type: string, listener: Listener) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		removeEventListener() {}
		send(data: string) {
			this.sentRef.push(data);
		}
		close() {}
	}
	const overrides: Record<string, unknown> = {
		window: win,
		document: win.document,
		HTMLElement: win.HTMLElement,
		Node: win.Node,
		Element: win.Element,
		navigator: win.navigator,
		location: win.location,
		localStorage: win.localStorage,
		sessionStorage: win.sessionStorage,
		WebSocket: FakeSocket,
		fetch: (input: unknown, init?: RequestInit) => {
			const exchanged = exchangeReply(String(input), init);
			return exchanged ? Promise.resolve(exchanged) : respond();
		},
		setTimeout: (callback: () => void, ms = 0) => {
			net.timeouts.push({ callback, ms });
			return net.timeouts.length;
		},
	};
	const target = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		if (key in target) saved[key] = target[key];
		target[key] = overrides[key];
	}
	return net;
}

afterEach(async () => {
	if (!openWindow) return;
	const target = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		if (key in saved) target[key] = saved[key];
		else delete target[key];
	}
	saved = {};
	await openWindow?.happyDOM.close();
	openWindow = undefined;
});

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await new Promise((r) => realSetTimeout(r, 10));
}

async function bootChat(net: Net): Promise<void> {
	imports += 1;
	await import(`../src/chat/page?delivery=${imports}`);
	await settle();
	for (const entry of net.timeouts.filter((t) => t.ms === 0)) entry.callback();
	net.timeouts = net.timeouts.filter((t) => t.ms !== 0);
	await settle();
}

function pill(net: Net): HTMLElement {
	return net.win.document.querySelector(
		".chat-rail__connection",
	) as unknown as HTMLElement;
}

function userRows(net: Net): HTMLElement[] {
	return [
		...net.win.document.querySelectorAll(".chat-transcript__message--user"),
	] as unknown as HTMLElement[];
}

function sentFrames(net: Net, index = 0): Record<string, unknown>[] {
	return (net.sockets[index]?.sent ?? []).map((raw) => JSON.parse(raw));
}

async function submit(net: Net, body: string): Promise<void> {
	const input = net.win.document.querySelector(
		".chat-composer__input",
	) as unknown as HTMLInputElement;
	input.value = body;
	input.dispatchEvent(
		new net.win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event,
	);
	await settle();
}

const CHAT_HREF = `http://127.0.0.1:${BOOTSTRAP.port}/chat#${pageFragment(BOOTSTRAP)}`;

describe("chat page booted from a /chat# fragment against a fake socket", () => {
	test("shows Connecting until the session-list handshake answer, then connected", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);

		expect(net.sockets[0]?.url).toBe(
			`ws://127.0.0.1:${BOOTSTRAP.port}/ws?token=${encodeURIComponent(BOOTSTRAP.token)}`,
		);
		net.sockets[0]?.handle.fire("open");
		await settle();

		expect(sentFrames(net).map((entry) => entry.type)).toContain("connect");
		expect(pill(net).dataset.connection).toBe("connecting");
		expect(pill(net).textContent).toBe("Connecting…");

		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();

		expect(pill(net).dataset.connection).toBe("connected");
		expect(pill(net).textContent).toBe("");
	});

	test("renders hello as pending until its ack, then as delivered", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();

		await submit(net, "hello");

		const written = sentFrames(net).find((entry) => entry.type === "user-message");
		expect(written?.body).toBe("hello");
		expect(userRows(net)).toHaveLength(1);
		expect(userRows(net)[0]?.textContent).toContain("hello");
		expect(userRows(net)[0]?.dataset.delivery).toBe("pending");

		net.sockets[0]?.handle.receive(frame("ack", { messageId: written?.messageId }));
		await settle();

		expect(userRows(net)[0]?.dataset.delivery).toBe("delivered");
	});

	test("marks hello not delivered with the exact text when no ack arrives within 5 s, and a late ack clears the mark", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();
		await submit(net, "hello");
		const written = sentFrames(net).find((entry) => entry.type === "user-message");

		const timer = net.timeouts.find((entry) => entry.ms === ACK_TIMEOUT_MS);
		expect(timer).toBeDefined();
		timer?.callback();
		await settle();

		expect(userRows(net)[0]?.dataset.delivery).toBe("not-delivered");
		expect(userRows(net)[0]?.textContent).toContain(NOT_DELIVERED_TEXT);

		net.sockets[0]?.handle.receive(frame("ack", { messageId: written?.messageId }));
		await settle();

		expect(userRows(net)[0]?.dataset.delivery).toBe("delivered");
		expect(userRows(net)[0]?.textContent).not.toContain(NOT_DELIVERED_TEXT);
	});

	test("ignores an ack for an unknown messageId and leaves the pending row pending", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();
		await submit(net, "hello");

		net.sockets[0]?.handle.receive(frame("ack", { messageId: "unknown-id" }));
		await settle();

		expect(userRows(net)[0]?.dataset.delivery).toBe("pending");
	});

	test("never shows connected for a stale token and shows SESSION_ENDED_TEXT on an invalid-session error frame", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		await settle();

		net.sockets[0]?.handle.receive(
			frame("error", { code: "invalid-session", message: "stale token" }),
		);
		await settle();

		expect(pill(net).dataset.connection).not.toBe("connected");
		expect(net.win.document.body.textContent).toContain(SESSION_ENDED_TEXT);
	});

	test("never shows connected for a stale token whose upgrade is refused with 403 and shows SESSION_ENDED_TEXT", async () => {
		const net = installPage(CHAT_HREF, () =>
			Promise.resolve(new Response("refused", { status: 403 })),
		);
		await bootChat(net);

		net.sockets[0]?.handle.fire("close");
		await settle();

		expect(pill(net).dataset.connection).not.toBe("connected");
		expect(net.win.document.body.textContent).toContain(SESSION_ENDED_TEXT);
	});

	test("stays connecting after a reconnect until the new socket's session-list arrives", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();
		net.sockets[0]?.handle.fire("close");
		await settle();
		for (const entry of net.timeouts.splice(0)) entry.callback();
		await settle();
		expect(net.sockets.length).toBeGreaterThan(1);

		net.sockets[1]?.handle.fire("open");
		await settle();

		expect(sentFrames(net, 1).map((entry) => entry.type)).toContain("connect");
		expect(pill(net).dataset.connection).toBe("connecting");

		net.sockets[1]?.handle.receive(sessionList("cli"));
		await settle();

		expect(pill(net).dataset.connection).toBe("connected");
	});

	test("header changes from No agent listening to Agent attached when a re-broadcast session-list carries presence cli", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		net.sockets[0]?.handle.receive(sessionList("idle"));
		await settle();
		expect(net.win.document.body.textContent).toContain("No agent listening");

		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();

		expect(net.win.document.body.textContent).toContain("Agent attached");
		expect(net.win.document.body.textContent).not.toContain(
			"No agent listening",
		);
	});

	test("happy path: fragment to held session, hello out, agent-message reply rendered", async () => {
		const net = installPage(CHAT_HREF);
		await bootChat(net);
		net.sockets[0]?.handle.fire("open");
		net.sockets[0]?.handle.receive(sessionList("cli"));
		await settle();
		await submit(net, "hello");
		const written = sentFrames(net).find((entry) => entry.type === "user-message");
		net.sockets[0]?.handle.receive(frame("ack", { messageId: written?.messageId }));

		net.sockets[0]?.handle.receive(
			frame("agent-message", { body: "hello back" }),
		);
		await settle();

		expect(net.win.document.body.textContent).toContain("hello back");
		expect(userRows(net)[0]?.dataset.delivery).toBe("delivered");
	});
});

describe("bare /chat without a fragment (H6 characterization)", () => {
	test("H6: opens no socket and shows the no-session empty state", async () => {
		const net = installPage(`http://127.0.0.1:${BOOTSTRAP.port}/chat`);

		await bootChat(net);

		expect(net.sockets).toEqual([]);
		expect(net.win.document.body.textContent).toContain("No sessions yet");
	});
});
