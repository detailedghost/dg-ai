import { expect, spyOn, test } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type ChatFrame,
} from "@dg/common";
import { buildAgentMessageFrame } from "./utils/frame-fixtures";
import {
	type FakeSocket,
	flushMicrotasks,
	type MockFn,
	makeBootstrapFactory,
	makeFakeSocket,
	frameEvent as message,
} from "./utils/relay-harness";
import { buildSessionListFrame } from "./utils/frame-fixtures";

const { createChatClient } = await import("@dg/pages/chat/chat-client");

const makeBootstrap = makeBootstrapFactory({
	port: 47823,
	sessionId: "session-a",
	token: "token-a",
	agentIdentity: "claude-orchestrator",
});

function buildAckFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "ack" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		messageId: "msg-1",
		...overrides,
	};
}

function mockFn<Args extends unknown[], R>(
	impl: (...args: Args) => R,
): MockFn<Args, R> {
	const calls: Args[] = [];
	const fn = ((...args: Args) => {
		calls.push(args);
		return impl(...args);
	}) as MockFn<Args, R>;
	fn.mock = { calls };
	return fn;
}

function confirmSessions(socket: FakeSocket, ...sessionIds: string[]): void {
	socket.dispatch(
		"message",
		message(
			buildSessionListFrame(
				sessionIds.map((sessionId) => ({
					sessionId,
					agentIdentity: "claude-orchestrator",
				})),
			),
		),
	);
}

function sentFrames(socket: FakeSocket): ChatFrame[] {
	return socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
}

function mockHealthFetch(
	handler: (port: number) => { daemon: string; instanceId: string } | undefined,
) {
	return spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
		const port = Number(/:(\d+)\/healthz$/.exec(url)?.[1]);
		const health = handler(port);
		if (!health) return { ok: false } as unknown as Response;
		return { ok: true, json: async () => health } as unknown as Response;
	}) as unknown as typeof fetch);
}

test("sendUserMessage sends a frame carrying the connected session's own sessionId and token", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	socket.dispatch("open");
	confirmSessions(socket, bootstrap.sessionId);

	client.sendUserMessage(bootstrap.sessionId, "hello agent", {
		messageId: "msg-abc",
	});
	await flushMicrotasks();

	const userMessages = sentFrames(socket).filter(
		(f) => f.type === "user-message",
	);
	expect(userMessages).toHaveLength(1);
	expect(userMessages[0]).toMatchObject({
		type: "user-message",
		sessionId: bootstrap.sessionId,
		token: bootstrap.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		messageId: "msg-abc",
		body: "hello agent",
	});
});

test("sendUserMessage throws for a sessionId outside the socket's captured capability set", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap());
	socket.dispatch("open");

	expect(() => client.sendUserMessage("never-captured", "x")).toThrow();
});

test("drops an inbound frame for a session outside the capability set rather than misfiling it", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	socket.dispatch("open");

	const received: ChatFrame[] = [];
	client.onFrame((f: ChatFrame) => received.push(f));

	socket.dispatch(
		"message",
		message(buildAgentMessageFrame({ sessionId: "some-other-session" })),
	);
	expect(received).toHaveLength(0);

	socket.dispatch(
		"message",
		message(buildAgentMessageFrame({ sessionId: bootstrap.sessionId })),
	);
	expect(received).toHaveLength(1);
});

test("delivers an inbound overwatch-state frame without a chat-session capability", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap());
	socket.dispatch("open");
	const received: ChatFrame[] = [];
	client.onFrame((frame) => received.push(frame));

	socket.dispatch(
		"message",
		message({
			type: "overwatch-state",
			sessionId: OVERWATCH_SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			board: { lanes: [], merges: [] },
		}),
	);

	expect(received).toHaveLength(1);
	expect(received[0]?.type).toBe("overwatch-state");
});

test("drops an agent-message frame that uses the overwatch sentinel session id", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap());
	socket.dispatch("open");
	const received: ChatFrame[] = [];
	client.onFrame((frame) => received.push(frame));

	socket.dispatch(
		"message",
		message(
			buildAgentMessageFrame({
				sessionId: OVERWATCH_SESSION_ID,
				body: "not an overwatch frame",
			}),
		),
	);

	expect(received).toHaveLength(0);
});

test("delivers a session-list frame that uses the overwatch sentinel session id", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap());
	socket.dispatch("open");
	const received: ChatFrame[] = [];
	client.onFrame((frame) => received.push(frame));

	socket.dispatch(
		"message",
		message(buildSessionListFrame([], { sessionId: OVERWATCH_SESSION_ID })),
	);

	expect(received).toHaveLength(1);
	expect(received[0]?.type).toBe("session-list");
});

test("a malformed inbound payload is logged and dropped, never thrown past the demux", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap());
	socket.dispatch("open");
	const received: ChatFrame[] = [];
	client.onFrame((f: ChatFrame) => received.push(f));

	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(() =>
			socket.dispatch("message", { data: "{not json" }),
		).not.toThrow();
		expect(() =>
			socket.dispatch(
				"message",
				message({ type: "not-a-ratified-type", sessionId: "session-a" }),
			),
		).not.toThrow();
	} finally {
		warn.mockRestore();
		error.mockRestore();
	}
	expect(received).toHaveLength(0);
});

test("routes frames for two captured sessions independently, with no cross-talk, and drops a third unknown session", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap({ sessionId: "session-a", token: "token-a" }));
	socket.dispatch("open");
	client.connect(makeBootstrap({ sessionId: "session-b", token: "token-b" }));

	const forA: ChatFrame[] = [];
	const forB: ChatFrame[] = [];
	client.onFrame((f: ChatFrame) => {
		if (f.sessionId === "session-a") forA.push(f);
		if (f.sessionId === "session-b") forB.push(f);
	});

	socket.dispatch(
		"message",
		message(buildAgentMessageFrame({ sessionId: "session-a", body: "to A" })),
	);
	socket.dispatch(
		"message",
		message(buildAgentMessageFrame({ sessionId: "session-b", body: "to B" })),
	);
	socket.dispatch(
		"message",
		message(
			buildAgentMessageFrame({ sessionId: "session-c", body: "unknown" }),
		),
	);

	expect(forA).toHaveLength(1);
	expect((forA[0] as { body: string }).body).toBe("to A");
	expect(forB).toHaveLength(1);
	expect((forB[0] as { body: string }).body).toBe("to B");
});

test("a second captured session reuses the single existing socket rather than opening a second one", () => {
	const socket = makeFakeSocket(mockFn);
	const openSocket = mockFn(() => socket);
	const client = createChatClient({ openSocket });
	client.connect(makeBootstrap({ sessionId: "session-a" }));
	socket.dispatch("open");
	client.connect(makeBootstrap({ sessionId: "session-b" }));

	expect(openSocket.mock.calls.length).toBe(1);
});

test("connecting a second session while already connected immediately sends that session's own connect handshake and history-request on the shared socket", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap({ sessionId: "session-a", token: "token-a" }));
	socket.dispatch("open");

	client.connect(makeBootstrap({ sessionId: "session-b", token: "token-b" }));
	await flushMicrotasks();

	const rawFrames = socket.send.mock.calls.map(
		([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
	);
	const framesForB = rawFrames.filter((f) => f.sessionId === "session-b");
	expect(framesForB.map((f) => f.type).sort()).toEqual([
		"connect",
		"history-request",
	]);
	expect(framesForB.find((f) => f.type === "connect")).toMatchObject({
		sessionId: "session-b",
		token: "token-b",
	});
});

test("connection state never reports connected before the socket has fired open, and never after it closes", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });

	expect(client.getConnectionState()).not.toBe("connected");

	client.connect(makeBootstrap());
	expect(client.getConnectionState()).not.toBe("connected");

	socket.dispatch("open");
	expect(client.getConnectionState()).toBe("connected");

	socket.dispatch("close");
	expect(client.getConnectionState()).not.toBe("connected");
	expect(client.getConnectionState()).toBe("reconnecting");
});

test("reports daemon-not-running when the socket cannot even be opened, distinct from an in-flight reconnect attempt", () => {
	const client = createChatClient({
		openSocket: () => {
			throw new Error("ECONNREFUSED");
		},
	});

	client.connect(makeBootstrap());

	expect(client.getConnectionState()).toBe("daemon-not-running");
});

test("a synchronous openSocket throw during a scheduled reconnect attempt (not just the first connect) reports daemon-not-running rather than staying stuck reconnecting", () => {
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const firstSocket = makeFakeSocket(mockFn);
	let openCount = 0;
	const openSocket = (_url: string) => {
		openCount += 1;
		if (openCount === 1) return firstSocket;
		throw new Error("ECONNREFUSED");
	};

	const fetchSpy = mockHealthFetch(() => undefined);
	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		client.connect(makeBootstrap());
		firstSocket.dispatch("open");
		expect(client.getConnectionState()).toBe("connected");

		firstSocket.dispatch("close");
		expect(client.getConnectionState()).toBe("reconnecting");

		const reconnectTimer = scheduled.shift();
		expect(reconnectTimer).toBeDefined();
		reconnectTimer?.();

		expect(client.getConnectionState()).toBe("daemon-not-running");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("a synchronous openSocket throw during a scheduled reconnect attempt still leaves a further retry pending, so the client reconnects once the daemon comes back", () => {
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const firstSocket = makeFakeSocket(mockFn);
	const thirdSocket = makeFakeSocket(mockFn);
	let openCount = 0;
	const openSocket = (_url: string) => {
		openCount += 1;
		if (openCount === 1) return firstSocket;
		if (openCount === 2) throw new Error("ECONNREFUSED");
		return thirdSocket;
	};

	const fetchSpy = mockHealthFetch(() => undefined);
	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		client.connect(makeBootstrap());
		firstSocket.dispatch("open");
		firstSocket.dispatch("close");

		scheduled.shift()?.();
		expect(client.getConnectionState()).toBe("daemon-not-running");

		const secondRetry = scheduled.shift();
		expect(secondRetry).toBeDefined();
		secondRetry?.();
		thirdSocket.dispatch("open");

		expect(client.getConnectionState()).toBe("connected");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("rediscovers the daemon over CHAT_DEFAULT_PORT's fallback range via GET /healthz, matching instanceId over a decoy dg-daemon, once the cached port goes stale", async () => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn((_url: string) => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	const decoyPort = CHAT_DEFAULT_PORT + 1;
	const relocatedPort =
		CHAT_DEFAULT_PORT + Math.min(3, CHAT_PORT_FALLBACK_COUNT);
	let daemonRestarted = false;
	const fetchSpy = mockHealthFetch((port) => {
		if (!daemonRestarted) {
			if (port === CHAT_DEFAULT_PORT) {
				return { daemon: "dg-daemon", instanceId: "inst-fixed" };
			}
			return undefined;
		}
		if (port === decoyPort)
			return { daemon: "dg-daemon", instanceId: "inst-other" };
		if (port === relocatedPort)
			return { daemon: "dg-daemon", instanceId: "inst-fixed" };
		return undefined;
	});

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		client.connect(makeBootstrap({ port: CHAT_DEFAULT_PORT }));
		sockets[0]?.dispatch("open");

		await flushMicrotasks(30);

		daemonRestarted = true;
		sockets[0]?.dispatch("close");

		const reconnectTimer = scheduled.shift();
		expect(reconnectTimer).toBeDefined();
		reconnectTimer?.();

		await flushMicrotasks(30);

		expect(sockets.length).toBe(2);
		expect(openSocket.mock.calls.at(-1)?.[0]).toBe(
			`ws://127.0.0.1:${relocatedPort}/ws`,
		);

		sockets[1]?.dispatch("open");
		expect(client.getConnectionState()).toBe("connected");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("rediscovers the daemon on a fallback port even when the cached port was already stale on the very first connect, before any open ever succeeded", async () => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn((_url: string) => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	const relocatedPort =
		CHAT_DEFAULT_PORT + Math.min(2, CHAT_PORT_FALLBACK_COUNT);
	const fetchSpy = mockHealthFetch((port) =>
		port === relocatedPort
			? { daemon: "dg-daemon", instanceId: "inst-1" }
			: undefined,
	);

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		client.connect(makeBootstrap({ port: CHAT_DEFAULT_PORT }));

		sockets[0]?.dispatch("close");

		const reconnectTimer = scheduled.shift();
		expect(reconnectTimer).toBeDefined();
		reconnectTimer?.();
		await flushMicrotasks(30);

		expect(sockets.length).toBe(2);
		expect(openSocket.mock.calls.at(-1)?.[0]).toBe(
			`ws://127.0.0.1:${relocatedPort}/ws`,
		);

		sockets[1]?.dispatch("open");
		expect(client.getConnectionState()).toBe("connected");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("schedules a reconnect after the socket drops, with a delay that grows across attempts and honors the injected jitter seam", () => {
	const socket = makeFakeSocket(mockFn);
	const jitteredSocket = makeFakeSocket(mockFn);
	const delaysWithZeroJitter: number[] = [];
	const delaysWithMaxJitter: number[] = [];
	const realSetTimeout = globalThis.setTimeout;

	function captureDelays(sink: number[]): void {
		globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
			sink.push(ms ?? 0);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
	}

	try {
		captureDelays(delaysWithZeroJitter);
		const clientZero = createChatClient({
			openSocket: () => socket,
			backoffBaseMs: 100,
			backoffMaxMs: 10_000,
			randomJitter: () => 0,
		});
		clientZero.connect(makeBootstrap());
		socket.dispatch("close");
		socket.dispatch("close");

		captureDelays(delaysWithMaxJitter);
		const clientJittered = createChatClient({
			openSocket: () => jitteredSocket,
			backoffBaseMs: 100,
			backoffMaxMs: 10_000,
			randomJitter: () => 1,
		});
		clientJittered.connect(makeBootstrap());
		jitteredSocket.dispatch("close");
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}

	expect(delaysWithZeroJitter.length).toBeGreaterThanOrEqual(2);
	expect(delaysWithZeroJitter[1]).toBeGreaterThan(delaysWithZeroJitter[0]);
	expect(delaysWithMaxJitter[0]).toBeGreaterThan(delaysWithZeroJitter[0]);
});

test("reconnect backoff is capped at backoffMaxMs even after many failures", () => {
	const socket = makeFakeSocket(mockFn);
	const scheduled: Array<() => void> = [];
	const delays: number[] = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		delays.push(ms ?? 0);
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	try {
		const client = createChatClient({
			openSocket: () => socket,
			backoffBaseMs: 10,
			backoffMaxMs: 50,
			randomJitter: () => 0,
		});
		client.connect(makeBootstrap());
		for (let i = 0; i < 6; i++) {
			socket.dispatch("close");
			const next = scheduled.shift();
			next?.();
		}
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}

	for (const d of delays) {
		expect(d).toBeLessThanOrEqual(50);
	}
});

function fireScheduledReconnect(scheduled: Array<() => void>): void {
	const next = scheduled.shift();
	expect(next).toBeDefined();
	next?.();
}

test("messages composed while disconnected are queued and flushed exactly once, in order, once the reconnected socket opens", async () => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn(() => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		const bootstrap = makeBootstrap();
		client.connect(bootstrap);
		sockets[0]?.dispatch("open");
		confirmSessions(sockets[0] as FakeSocket, bootstrap.sessionId);
		sockets[0]?.dispatch("close");

		const firstId = client.sendUserMessage(bootstrap.sessionId, "first", {
			messageId: "msg-first",
		});
		const secondId = client.sendUserMessage(bootstrap.sessionId, "second", {
			messageId: "msg-second",
		});

		expect(
			sentFrames(sockets[0] as FakeSocket).filter(
				(f) => f.type === "user-message",
			),
		).toHaveLength(0);

		fireScheduledReconnect(scheduled);
		sockets[1]?.dispatch("open");
		confirmSessions(sockets[1] as FakeSocket, bootstrap.sessionId);
		await flushMicrotasks();

		const flushed = sentFrames(sockets[1] as FakeSocket).filter(
			(f) => f.type === "user-message",
		);
		expect(flushed.map((f) => (f as { messageId: string }).messageId)).toEqual([
			firstId,
			secondId,
		]);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("does not resend a message already acked before the drop, but does resend one that was never acked", async () => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn(() => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		const bootstrap = makeBootstrap();
		client.connect(bootstrap);
		sockets[0]?.dispatch("open");
		confirmSessions(sockets[0] as FakeSocket, bootstrap.sessionId);

		const ackedId = client.sendUserMessage(bootstrap.sessionId, "acked", {
			messageId: "msg-acked",
		});
		sockets[0]?.dispatch(
			"message",
			message(
				buildAckFrame({ sessionId: bootstrap.sessionId, messageId: ackedId }),
			),
		);
		const unackedId = client.sendUserMessage(bootstrap.sessionId, "unacked", {
			messageId: "msg-unacked",
		});

		sockets[0]?.dispatch("close");
		fireScheduledReconnect(scheduled);
		sockets[1]?.dispatch("open");
		confirmSessions(sockets[1] as FakeSocket, bootstrap.sessionId);
		await flushMicrotasks();

		const resent = sentFrames(sockets[1] as FakeSocket)
			.filter((f) => f.type === "user-message")
			.map((f) => (f as { messageId: string }).messageId);
		expect(resent).toEqual([unackedId]);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("an ack for a messageId not in the outbox is ignored, leaving queued messages intact for the next flush", async () => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn(() => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		const bootstrap = makeBootstrap();
		client.connect(bootstrap);
		sockets[0]?.dispatch("open");
		confirmSessions(sockets[0] as FakeSocket, bootstrap.sessionId);

		const queuedId = client.sendUserMessage(
			bootstrap.sessionId,
			"still queued",
			{
				messageId: "msg-real",
			},
		);

		sockets[0]?.dispatch(
			"message",
			message(
				buildAckFrame({
					sessionId: bootstrap.sessionId,
					messageId: "msg-phantom",
				}),
			),
		);

		sockets[0]?.dispatch("close");
		fireScheduledReconnect(scheduled);
		sockets[1]?.dispatch("open");
		confirmSessions(sockets[1] as FakeSocket, bootstrap.sessionId);
		await flushMicrotasks();

		const resent = sentFrames(sockets[1] as FakeSocket)
			.filter((f) => f.type === "user-message")
			.map((f) => (f as { messageId: string }).messageId);
		expect(resent).toEqual([queuedId]);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("requests history backfill immediately on connect, and again on every reconnect", async () => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn(() => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		const bootstrap = makeBootstrap();
		client.connect(bootstrap);
		sockets[0]?.dispatch("open");
		await flushMicrotasks();

		const firstHistoryRequests = sentFrames(sockets[0] as FakeSocket).filter(
			(f) => f.type === "history-request",
		);
		expect(firstHistoryRequests).toHaveLength(1);
		expect(firstHistoryRequests[0]).toMatchObject({
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});

		sockets[0]?.dispatch("close");
		fireScheduledReconnect(scheduled);
		sockets[1]?.dispatch("open");
		await flushMicrotasks();

		const secondHistoryRequests = sentFrames(sockets[1] as FakeSocket).filter(
			(f) => f.type === "history-request",
		);
		expect(secondHistoryRequests).toHaveLength(1);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("regression: a second connect() call while the daemon is unreachable does not open a second independent socket, so a message queued before it connects is sent exactly once", async () => {
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const sockets: FakeSocket[] = [];
	let openCount = 0;
	const openSocket = mockFn((_url: string) => {
		openCount += 1;
		if (openCount === 1) throw new Error("ECONNREFUSED");
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});
	const fetchSpy = mockHealthFetch(() => undefined);

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		const bootstrapA = makeBootstrap({
			sessionId: "session-a",
			token: "token-a",
		});
		client.connect(bootstrapA);
		expect(client.getConnectionState()).toBe("daemon-not-running");

		const messageId = client.sendUserMessage(bootstrapA.sessionId, "hello", {
			messageId: "msg-1",
		});

		const bootstrapB = makeBootstrap({
			sessionId: "session-b",
			token: "token-b",
		});
		client.connect(bootstrapB);
		expect(sockets).toHaveLength(0);
		expect(scheduled).toHaveLength(1);

		fireScheduledReconnect(scheduled);
		await flushMicrotasks(30);
		sockets[0]?.dispatch("open");
		confirmSessions(sockets[0] as FakeSocket, bootstrapA.sessionId);
		await flushMicrotasks();

		const sent = sentFrames(sockets[0] as FakeSocket).filter(
			(f) =>
				f.type === "user-message" &&
				(f as { messageId: string }).messageId === messageId,
		);
		expect(sent).toHaveLength(1);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("regression: a superseded reconnect timer is cleared, so firing close twice in a row never leaves two live retry timers", () => {
	const socket = makeFakeSocket(mockFn);
	let nextHandle = 1;
	const setTimeoutCalls: number[] = [];
	const clearTimeoutCalls: number[] = [];
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((_fn: () => void) => {
		const handle = nextHandle++;
		setTimeoutCalls.push(handle);
		return handle as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: unknown) => {
		clearTimeoutCalls.push(handle as number);
	}) as typeof clearTimeout;

	try {
		const client = createChatClient({
			openSocket: () => socket,
			backoffBaseMs: 5,
		});
		client.connect(makeBootstrap());
		socket.dispatch("close");
		socket.dispatch("close");

		expect(setTimeoutCalls).toEqual([1, 2]);
		expect(clearTimeoutCalls).toEqual([1]);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test("sendUserMessage throws for a body exceeding CHAT_MAX_MESSAGE_BODY_BYTES rather than queueing it for endless resend", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	socket.dispatch("open");
	await flushMicrotasks();
	const beforeCount = socket.send.mock.calls.length;

	const oversized = "x".repeat(CHAT_MAX_MESSAGE_BODY_BYTES + 1);
	expect(() => client.sendUserMessage(bootstrap.sessionId, oversized)).toThrow(
		/CHAT_MAX_MESSAGE_BODY_BYTES/,
	);

	await flushMicrotasks();
	expect(socket.send.mock.calls.length).toBe(beforeCount);
});

test("a session-pending frame grants capability for the newly created session, so sendUserMessage on it succeeds", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const requester = makeBootstrap({
		sessionId: "session-a",
		token: "token-a",
	});
	client.connect(requester);
	socket.dispatch("open");

	expect(() => client.sendUserMessage("session-new", "hi")).toThrow();

	socket.dispatch(
		"message",
		message({
			type: "session-pending",
			sessionId: requester.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			newSession: { sessionId: "session-new", token: "token-new" },
		}),
	);
	confirmSessions(socket, "session-new");

	expect(() => client.sendUserMessage("session-new", "hi")).not.toThrow();
	await flushMicrotasks();
	const sent = sentFrames(socket).filter(
		(f) => f.type === "user-message" && f.sessionId === "session-new",
	);
	expect(sent).toHaveLength(1);
});

test("a session-closed frame revokes the session's capability and prunes its queued outbox entries", async () => {
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const sockets: FakeSocket[] = [];
	const openSocket = mockFn(() => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		const bootstrap = makeBootstrap({
			sessionId: "session-a",
			token: "token-a",
		});
		client.connect(bootstrap);
		sockets[0]?.dispatch("open");

		sockets[0]?.dispatch("close");
		client.sendUserMessage(bootstrap.sessionId, "queued", { messageId: "m1" });

		sockets[0]?.dispatch(
			"message",
			message({
				type: "session-closed",
				sessionId: bootstrap.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);

		expect(() =>
			client.sendUserMessage(bootstrap.sessionId, "after-close"),
		).toThrow();

		fireScheduledReconnect(scheduled);
		sockets[1]?.dispatch("open");
		confirmSessions(sockets[1] as FakeSocket, bootstrap.sessionId);
		await flushMicrotasks();

		const resent = sentFrames(sockets[1] as FakeSocket).filter(
			(f) => f.type === "user-message",
		);
		expect(resent).toHaveLength(0);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test.each([
	["dg-daemon", true],
	["dg-server", true],
	["dg-relay", false],
	["", false],
])("treats a /healthz answer naming %p as a usable daemon: %p", async (daemon, usable) => {
	const sockets: FakeSocket[] = [];
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	const openSocket = mockFn((_url: string) => {
		const s = makeFakeSocket(mockFn);
		sockets.push(s);
		return s;
	});
	const relocatedPort =
		CHAT_DEFAULT_PORT + Math.min(2, CHAT_PORT_FALLBACK_COUNT);
	const fetchSpy = mockHealthFetch((port) =>
		port === relocatedPort ? { daemon, instanceId: "inst-1" } : undefined,
	);

	try {
		const client = createChatClient({ openSocket, backoffBaseMs: 5 });
		client.connect(makeBootstrap({ port: CHAT_DEFAULT_PORT }));
		sockets[0]?.dispatch("close");
		scheduled.shift()?.();
		await flushMicrotasks(30);

		const reached = openSocket.mock.calls
			.map(([url]) => url)
			.includes(`ws://127.0.0.1:${relocatedPort}/ws`);
		expect(reached).toBe(usable);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

function sentConnect(socket: FakeSocket): Record<string, unknown> | undefined {
	return socket.send.mock.calls
		.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>)
		.find((f) => f.type === "connect");
}

test("the connect handshake carries the extension version when the client knows it", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({
		openSocket: () => socket,
		extensionVersion: "1.9.3",
	});
	client.connect(makeBootstrap());
	socket.dispatch("open");
	await flushMicrotasks();

	expect(sentConnect(socket)).toMatchObject({
		extensionVersion: "1.9.3",
	});
});

test("the connect handshake omits the extension version when none is configured", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	client.connect(makeBootstrap());
	socket.dispatch("open");
	await flushMicrotasks();

	expect(sentConnect(socket)).not.toHaveProperty("extensionVersion");
});

test("announces each connection change with a detail naming the port when the socket errors", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const changes: Array<[string, string | undefined]> = [];
	client.onConnectionChange((state, detail) => changes.push([state, detail]));

	client.connect(makeBootstrap({ port: 47823 }));
	socket.dispatch("error");
	socket.dispatch("open");

	expect(changes).toEqual([
		["reconnecting", "could not reach the daemon on port 47823"],
		["connected", undefined],
	]);
});

test("announces daemon-not-running when the socket cannot be opened", () => {
	const client = createChatClient({
		openSocket: () => {
			throw new Error("ECONNREFUSED");
		},
	});
	const changes: string[] = [];
	client.onConnectionChange((state) => changes.push(state));

	client.connect(makeBootstrap());

	expect(changes).toEqual(["daemon-not-running"]);
});



test("disconnectSession removes only the selected capability after daemon confirmation and keeps the shared connection open", async () => {
	const socket = makeFakeSocket(mockFn);
	const close = mockFn(() => socket.dispatch("close"));
	Object.assign(socket, { close });
	const openSocket = mockFn(() => socket);
	const client = createChatClient({ openSocket });
	const older = makeBootstrap();
	const newer = makeBootstrap({ sessionId: "session-b", token: "token-b" });
	client.connect(older);
	client.connect(newer);
	socket.dispatch("open");
	confirmSessions(socket, older.sessionId, newer.sessionId);
	await flushMicrotasks();
	const disconnected = client.disconnectSession(older.sessionId);
	await flushMicrotasks();
	expect(sentFrames(socket).filter((frame) => frame.type === "session-disconnect")).toEqual([expect.objectContaining({ sessionId: older.sessionId, token: older.token })]);
	socket.dispatch("message", message({ type: "session-disconnected", sessionId: older.sessionId, protocolVersion: CHAT_PROTOCOL_VERSION }));
	await disconnected;
	expect(close.mock.calls).toHaveLength(0);
	expect(openSocket.mock.calls).toHaveLength(1);
	expect(client.getConnectionState()).toBe("connected");
	expect(() => client.sendUserMessage(older.sessionId, "blocked")).toThrow();
	client.sendUserMessage(newer.sessionId, "still connected");
	await flushMicrotasks();
	expect(sentFrames(socket).some((frame) => frame.type === "user-message" && frame.sessionId === newer.sessionId)).toBe(true);
});

test("disconnecting the last capability closes only after confirmation and can be paired again", async () => {
	const first = makeFakeSocket(mockFn);
	const close = mockFn(() => first.dispatch("close"));
	Object.assign(first, { close });
	const second = makeFakeSocket(mockFn);
	const openSocket = mockFn((): FakeSocket => openSocket.mock.calls.length === 1 ? first : second);
	const client = createChatClient({ openSocket });
	const session = makeBootstrap();
	client.connect(session);
	first.dispatch("open");
	const pending = client.disconnectSession(session.sessionId);
	expect(close.mock.calls).toHaveLength(0);
	await flushMicrotasks();
	first.dispatch("message", message({ type: "session-disconnected", sessionId: session.sessionId, protocolVersion: CHAT_PROTOCOL_VERSION }));
	await pending;
	first.dispatch("error");
	first.dispatch("close");
	expect(client.getConnectionState()).not.toBe("connected");
	expect(openSocket.mock.calls).toHaveLength(1);
	expect(close.mock.calls).toHaveLength(1);
	client.connect(session);
	second.dispatch("open");
	await flushMicrotasks();
	expect(openSocket.mock.calls).toHaveLength(2);
});

test("an unsupported or refused disconnect preserves the session and rejects the operation", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const session = makeBootstrap();
	client.connect(session);
	socket.dispatch("open");
	const pending = client.disconnectSession(session.sessionId);
	socket.dispatch("message", message({ type: "error", sessionId: session.sessionId, protocolVersion: CHAT_PROTOCOL_VERSION, message: "unknown frame" }));
	await expect(pending).rejects.toThrow("did not confirm disconnect");
	expect(client.getConnectionState()).toBe("connected");
	expect(() => client.sendUserMessage(session.sessionId, "still available")).not.toThrow();
});

test("sendCommandInvocation sends a command-invocation frame with the session's own token", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	socket.dispatch("open");

	const result = await client.sendCommandInvocation?.(
		bootstrap.sessionId,
		"review",
	);
	await flushMicrotasks();

	expect(result).toEqual({ ok: true });
	expect(
		sentFrames(socket).filter((f) => f.type === "command-invocation"),
	).toEqual([
		{
			type: "command-invocation",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			commandLabel: "review",
			params: {},
		},
	]);
});

test("sendCommandInvocation refuses a session the client never connected", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });

	const result = await client.sendCommandInvocation?.("session-x", "review");

	expect(result).toEqual({
		ok: false,
		error: "no chat session is open — start one to run a command",
	});
	expect(socket.send.mock.calls).toEqual([]);
});

test("sendCommandInvocation reports a failure and sends nothing while the socket is not connected", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);

	const result = await client.sendCommandInvocation?.(
		bootstrap.sessionId,
		"review",
	);
	await flushMicrotasks();

	expect(result).toEqual({
		ok: false,
		error: "the daemon is not connected — retry once the chat reconnects",
	});
	expect(
		sentFrames(socket).filter((f) => f.type === "command-invocation"),
	).toEqual([]);
});

const makeSecondBootstrap = () =>
	makeBootstrap({ sessionId: "session-b", token: "token-b" });

function frameSummary(socket: FakeSocket, from = 0) {
	return socket.send.mock.calls
		.slice(from)
		.map(
			([raw]) =>
				JSON.parse(raw as string) as {
					type: string;
					sessionId: string;
					token?: string;
				},
		)
		.map((frame) => ({
			type: frame.type,
			sessionId: frame.sessionId,
			token: frame.token,
		}));
}

test("addSession on a connected client sends connect and history-request for the new session and nothing else", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const first = makeBootstrap();
	const second = makeSecondBootstrap();
	client.connect(first);
	socket.dispatch("open");
	await flushMicrotasks();
	const before = socket.send.mock.calls.length;

	client.addSession(second);
	await flushMicrotasks();

	expect(frameSummary(socket, before)).toEqual([
		{ type: "connect", sessionId: second.sessionId, token: second.token },
		{ type: "history-request", sessionId: second.sessionId, token: second.token },
	]);
});

test("addSession on a connected client keeps the socket open", async () => {
	let opened = 0;
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({
		openSocket: () => {
			opened += 1;
			return socket;
		},
	});
	client.connect(makeBootstrap());
	socket.dispatch("open");

	client.addSession(makeSecondBootstrap());
	await flushMicrotasks();

	expect(opened).toBe(1);
});

test("addSession before the socket opens joins the open-time handshake for both sessions exactly once", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const first = makeBootstrap();
	const second = makeSecondBootstrap();
	client.connect(first);

	client.addSession(second);
	expect(socket.send.mock.calls).toHaveLength(0);
	socket.dispatch("open");
	await flushMicrotasks();

	const summary = frameSummary(socket);
	for (const bootstrap of [first, second]) {
		for (const type of ["connect", "history-request"]) {
			expect(
				summary.filter(
					(frame) => frame.type === type && frame.sessionId === bootstrap.sessionId,
				),
			).toHaveLength(1);
		}
	}
});

test("addSession for a session the client already holds sends nothing", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const first = makeBootstrap();
	client.connect(first);
	socket.dispatch("open");
	await flushMicrotasks();
	const before = socket.send.mock.calls.length;

	client.addSession(first);
	client.addSession({ ...first, token: "another-token" });
	await flushMicrotasks();

	expect(socket.send.mock.calls).toHaveLength(before);
});

test("a session added with addSession is unconfirmed until a session-list includes it", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const first = makeBootstrap();
	const second = makeSecondBootstrap();
	client.connect(first);
	socket.dispatch("open");
	confirmSessions(socket, first.sessionId);

	client.addSession(second);

	expect(client.isSessionConfirmed?.(first.sessionId)).toBe(true);
	expect(client.isSessionConfirmed?.(second.sessionId)).toBe(false);

	confirmSessions(socket, first.sessionId, second.sessionId);

	expect(client.isSessionConfirmed?.(second.sessionId)).toBe(true);
});

test("a session added with addSession can send once confirmed", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const second = makeSecondBootstrap();
	client.connect(makeBootstrap());
	socket.dispatch("open");
	client.addSession(second);
	confirmSessions(socket, second.sessionId);

	client.sendUserMessage(second.sessionId, "hello b", { messageId: "msg-b" });
	await flushMicrotasks();

	expect(
		sentFrames(socket).find((frame) => frame.type === "user-message"),
	).toMatchObject({ sessionId: second.sessionId, token: second.token, body: "hello b" });
});

test("session-list frames reach listeners unfiltered, including sessions the client does not hold", () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const received: ChatFrame[] = [];
	client.onFrame((frame) => received.push(frame));
	client.connect(makeBootstrap());
	socket.dispatch("open");

	confirmSessions(socket, "session-a", "not-held");

	const list = received.find((frame) => frame.type === "session-list");
	expect(
		list?.type === "session-list" && list.sessions.map((entry) => entry.sessionId),
	).toEqual(["session-a", "not-held"]);
});

test("admitPort refuses a daemon that fails the check before any frame carrying a token is sent", async () => {
	const socket = makeFakeSocket(mockFn);
	const close = mockFn(() => socket.dispatch("close"));
	const client = createChatClient({
		openSocket: () => ({ ...socket, close }),
		admitPort: async () => false,
		backoffBaseMs: 60_000,
	});
	client.connect(makeBootstrap());

	socket.dispatch("open");
	await flushMicrotasks();

	expect(close.mock.calls.length).toBe(1);
	expect(socket.send.mock.calls.length).toBe(0);
	expect(client.getConnectionState()).toBe("reconnecting");
});

test("admitPort lets the handshake through for a daemon that passes the check", async () => {
	const socket = makeFakeSocket(mockFn);
	const checked: number[] = [];
	const client = createChatClient({
		openSocket: () => socket,
		admitPort: async (port) => {
			checked.push(port);
			return true;
		},
	});
	client.connect(makeBootstrap());

	socket.dispatch("open");
	await flushMicrotasks();

	expect(checked).toEqual([47823]);
	expect((sentFrames(socket)[0] as { type: string }).type).toBe("connect");
	expect(client.getConnectionState()).toBe("connected");
});

test("findPort replaces the unpinned fallback when the socket reconnects", async () => {
	const sockets = [makeFakeSocket(mockFn), makeFakeSocket(mockFn)];
	const urls: string[] = [];
	let opened = 0;
	const client = createChatClient({
		openSocket: (url) => {
			urls.push(url);
			return sockets[opened++] as never;
		},
		findPort: async () => 47825,
		backoffBaseMs: 1,
		randomJitter: () => 0,
	});
	client.connect(makeBootstrap());
	sockets[0]?.dispatch("open");
	await flushMicrotasks();

	sockets[0]?.dispatch("close");
	await new Promise((resolve) => setTimeout(resolve, 30));

	expect(urls.at(-1)).toContain(":47825/");
});

test("frames that arrive before admitPort resolves are ignored, so a squatter cannot trigger a token send", async () => {
	const socket = makeFakeSocket(mockFn);
	let admit: (admitted: boolean) => void = () => undefined;
	const client = createChatClient({
		openSocket: () => ({ ...socket, close: () => undefined }),
		admitPort: () =>
			new Promise<boolean>((resolve) => {
				admit = resolve;
			}),
	});
	const seen: string[] = [];
	client.onFrame((frame) => seen.push(frame.type));
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	socket.dispatch("open");

	confirmSessions(socket, bootstrap.sessionId);
	admit(false);
	await flushMicrotasks();
	confirmSessions(socket, bootstrap.sessionId);

	expect(seen).toEqual([]);
	expect(socket.send.mock.calls.length).toBe(0);
});

test("frames flow once admitPort accepts the daemon", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({
		openSocket: () => socket,
		admitPort: async () => true,
	});
	const seen: string[] = [];
	client.onFrame((frame) => seen.push(frame.type));
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	socket.dispatch("open");
	await flushMicrotasks();

	confirmSessions(socket, bootstrap.sessionId);

	expect(seen).toEqual(["session-list"]);
});

test("a late admission for a socket that already closed does not mark the client connected", async () => {
	const socket = makeFakeSocket(mockFn);
	let admit: (admitted: boolean) => void = () => undefined;
	const client = createChatClient({
		openSocket: () => socket,
		admitPort: () =>
			new Promise<boolean>((resolve) => {
				admit = resolve;
			}),
		backoffBaseMs: 60_000,
	});
	client.connect(makeBootstrap());
	socket.dispatch("open");
	socket.dispatch("close");

	admit(true);
	await flushMicrotasks();

	expect(client.getConnectionState()).toBe("reconnecting");
	expect(socket.send.mock.calls.length).toBe(0);
});

test("a replacement socket sends nothing, not even an unpair, until its daemon is admitted", async () => {
	const sockets = [makeFakeSocket(mockFn), makeFakeSocket(mockFn)];
	let opened = 0;
	let admitCalls = 0;
	let admitSecond: (admitted: boolean) => void = () => undefined;
	const client = createChatClient({
		openSocket: () => sockets[opened++] as never,
		admitPort: () => {
			admitCalls += 1;
			return admitCalls === 1
				? Promise.resolve(true)
				: new Promise<boolean>((resolve) => {
						admitSecond = resolve;
					});
		},
	});
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();
	sockets[0]?.send.mock.calls.splice(0);

	client.retryNow();
	sockets[1]?.dispatch("open");
	void client.disconnectSession(bootstrap.sessionId).catch(() => undefined);
	client.closeSession(bootstrap.sessionId);
	await flushMicrotasks();
	admitSecond(false);
	await flushMicrotasks();

	expect(sockets[1]?.send.mock.calls.length).toBe(0);
});

const ADOPT_BOOTSTRAP = {
	port: 47823,
	sessionId: "pushed-session",
	token: "pushed-token",
	agentIdentity: "claude-orchestrator",
	daemonId: "daemon-test",
};

function linkClient(options: Record<string, unknown> = {}) {
	const adopted: unknown[] = [];
	const sockets: FakeSocket[] = [];
	const closes: MockFn<[]>[] = [];
	const client = createChatClient({
		openSocket: () => {
			const socket = makeFakeSocket(mockFn);
			const close = mockFn(() => undefined);
			closes.push(close);
			sockets.push(socket);
			return { ...socket, close } as never;
		},
		link: { onSessionAdopt: (bootstrap) => adopted.push(bootstrap) },
		backoffBaseMs: 1,
		randomJitter: () => 0,
		...options,
	});
	return { client, adopted, sockets, closes };
}

test("a link client connects with zero capabilities and sends no frame on open", async () => {
	const { client, sockets } = linkClient();
	client.openLink?.(47823);

	sockets[0]?.dispatch("open");
	await flushMicrotasks();

	expect(client.getConnectionState()).toBe("connected");
	expect(sockets[0]?.send.mock.calls.length).toBe(0);
});

test("a link client reconnects after the socket closes with zero capabilities", async () => {
	const { client, sockets } = linkClient({ findPort: async () => 47824 });
	client.openLink?.(47823);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();

	sockets[0]?.dispatch("close");
	await new Promise((resolve) => setTimeout(resolve, 30));

	expect(sockets.length).toBe(2);
	expect(client.getPort?.()).toBe(47824);
});

test("a client without a link option does not reconnect with zero capabilities", async () => {
	const sockets: FakeSocket[] = [];
	const client = createChatClient({
		openSocket: () => {
			const socket = makeFakeSocket(mockFn);
			sockets.push(socket);
			return socket;
		},
		findPort: async () => 47824,
		backoffBaseMs: 1,
		randomJitter: () => 0,
	});
	const bootstrap = makeBootstrap();
	client.connect(bootstrap);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();
	client.forgetSession(bootstrap.sessionId);

	expect(sockets.length).toBe(1);
	expect(client.getConnectionState()).toBe("daemon-not-running");
});

test("a link client keeps its socket open when the last session is forgotten", async () => {
	const { client, sockets, closes } = linkClient();
	const bootstrap = makeBootstrap();
	client.openLink?.(47823);
	client.connect(bootstrap);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();

	client.forgetSession(bootstrap.sessionId);

	expect(closes[0]?.mock.calls.length).toBe(0);
	expect(client.getConnectionState()).toBe("connected");
});

test("a link client routes a session-adopt frame to the callback once the port is admitted", async () => {
	const { client, adopted, sockets } = linkClient({ admitPort: async () => true });
	client.openLink?.(47823);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();

	sockets[0]?.dispatch(
		"message",
		message({ type: "session-adopt", bootstrap: ADOPT_BOOTSTRAP }),
	);

	expect(adopted).toEqual([ADOPT_BOOTSTRAP]);
});

test("a session-adopt frame that arrives before admitPort resolves is ignored", async () => {
	let admit: (admitted: boolean) => void = () => undefined;
	const { client, adopted, sockets } = linkClient({
		admitPort: () =>
			new Promise<boolean>((resolve) => {
				admit = resolve;
			}),
	});
	client.openLink?.(47823);
	sockets[0]?.dispatch("open");

	sockets[0]?.dispatch(
		"message",
		message({ type: "session-adopt", bootstrap: ADOPT_BOOTSTRAP }),
	);
	admit(true);
	await flushMicrotasks();

	expect(adopted).toEqual([]);
});

test("a session-adopt frame without a daemonId is dropped", async () => {
	const { client, adopted, sockets } = linkClient();
	client.openLink?.(47823);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();
	const { daemonId: _omitted, ...unpinned } = ADOPT_BOOTSTRAP;

	sockets[0]?.dispatch(
		"message",
		message({ type: "session-adopt", bootstrap: unpinned }),
	);

	expect(adopted).toEqual([]);
});

test("a client without a link option drops session-adopt frames", async () => {
	const socket = makeFakeSocket(mockFn);
	const client = createChatClient({ openSocket: () => socket });
	const seen: string[] = [];
	client.onFrame((frame) => seen.push(frame.type));
	client.connect(makeBootstrap());
	socket.dispatch("open");
	await flushMicrotasks();

	socket.dispatch(
		"message",
		message({ type: "session-adopt", bootstrap: ADOPT_BOOTSTRAP }),
	);

	expect(seen).toEqual([]);
});

test("a link client passes a session-closed frame for an unheld session to listeners", async () => {
	const { client, sockets } = linkClient();
	const seen: string[] = [];
	client.onFrame((frame) => seen.push(frame.type));
	client.openLink?.(47823);
	sockets[0]?.dispatch("open");
	await flushMicrotasks();

	sockets[0]?.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: "pushed-session",
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);

	expect(seen).toEqual(["session-closed"]);
});
