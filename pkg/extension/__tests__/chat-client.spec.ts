import { expect, spyOn, test } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
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

const { createChatClient } = await import("@/lib/features/chat-client");

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

function sentFrames(socket: FakeSocket): ChatFrame[] {
	return socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
}

function mockHealthFetch(
	handler: (
		port: number,
	) => { daemon: "dg-server"; instanceId: string } | undefined,
) {
	return spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
		const port = Number(/:(\d+)\/health$/.exec(url)?.[1]);
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

test("rediscovers the daemon over CHAT_DEFAULT_PORT's fallback range via GET /health, matching instanceId over a decoy dg-server, once the cached port goes stale", async () => {
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
				return { daemon: "dg-server", instanceId: "inst-fixed" };
			}
			return undefined;
		}
		if (port === decoyPort)
			return { daemon: "dg-server", instanceId: "inst-other" };
		if (port === relocatedPort)
			return { daemon: "dg-server", instanceId: "inst-fixed" };
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
			? { daemon: "dg-server", instanceId: "inst-1" }
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
		await flushMicrotasks();

		const resent = sentFrames(sockets[1] as FakeSocket).filter(
			(f) => f.type === "user-message",
		);
		expect(resent).toHaveLength(0);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});
