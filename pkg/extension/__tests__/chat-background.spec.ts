/**
 * lib/background/chat.ts's registerChat: toolbar-click router, marker-capture
 * relay (storage.session write + tab open), and the keepalive that keeps a
 * session's WebSocket receiving while its chat tab is closed. Seam names are
 * pinned in plan.md's "Transport and naming ratifications (execute-mode, layer 1)".
 */

import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
	validateChatFrame,
} from "@dg/common";
import { CHAT_PAGE_PATH } from "@/lib/background/chat";

// registerTabGrouping (also in the barrel) reads browser.tabGroups at import
// time — stub it so importing the barrel below doesn't crash.
mock.module("wxt/browser", () => ({ browser: {} }));

const { registerChat, registerRecording } = await import("@/lib/background");
const { MSG } = await import("@/lib/chat-messages");
const { browser: mockedBrowser } = await import("wxt/browser");

function makeBootstrap(
	overrides: Partial<SessionBootstrap> = {},
): SessionBootstrap {
	return {
		port: CHAT_DEFAULT_PORT,
		sessionId: "sess-abc123",
		token: "tok-xyz789",
		agentIdentity: "claude-orchestrator",
		...overrides,
	};
}

/** Let queued microtasks/promise callbacks run, mirroring background-recording.spec.ts's settle(). */
const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

type Listener = (
	msg: unknown,
	sender: unknown,
	sendResponse: (r: unknown) => void,
) => boolean | undefined;
type ClickListener = (tab?: chrome.tabs.Tab) => void;

function makeBrowserApi() {
	let onMessageListener: Listener | undefined;
	let onClickedListener: ClickListener | undefined;
	const sessionSet = mock((_items: Record<string, unknown>) =>
		Promise.resolve(),
	);
	const tabsCreate = mock((_props: { url: string }) => Promise.resolve());
	const api = {
		action: {
			onClicked: {
				addListener: mock((cb: ClickListener) => {
					onClickedListener = cb;
				}),
			},
		},
		runtime: {
			onMessage: {
				addListener: mock((cb: Listener) => {
					onMessageListener = cb;
				}),
			},
			getURL: mock((path: string) => `chrome-extension://test-ext/${path}`),
		},
		tabs: { create: tabsCreate },
		storage: { session: { set: sessionSet } },
	};
	return {
		api,
		sessionSet,
		tabsCreate,
		getOnMessage: () => onMessageListener,
		getOnClicked: () => onClickedListener,
	};
}

test("registerChat is exported as a function from the background barrel", () => {
	expect(typeof registerChat).toBe("function");
});

test("the background entrypoint imports registerChat from the barrel and invokes it", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../entrypoints/background.ts", import.meta.url)),
		"utf8",
	);
	expect(source).toMatch(
		/import\s*\{[^}]*\bregisterChat\b[^}]*\}\s*from\s*["']@\/lib\/background["']/,
	);
	expect(source).toMatch(/registerChat\s*\(/);
});

test("a captured marker writes its bootstrap to storage.session and opens the chat page exactly once", async () => {
	const { api, sessionSet, tabsCreate, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api });
	const listener = getOnMessage();
	expect(typeof listener).toBe("function");
	const bootstrap = makeBootstrap();

	listener?.(
		{ type: MSG.markerCaptured, bootstrap },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(sessionSet).toHaveBeenCalledTimes(1);
	const [[written]] = sessionSet.mock.calls;
	expect(Object.values(written)).toContainEqual(bootstrap);
	expect(tabsCreate).toHaveBeenCalledTimes(1);
	expect(tabsCreate).toHaveBeenCalledWith({
		url: api.runtime.getURL(CHAT_PAGE_PATH),
	});
});

test("ignores a marker-captured message carrying a malformed bootstrap rather than partially storing it", async () => {
	const { api, sessionSet, tabsCreate, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api });
	const listener = getOnMessage();

	listener?.(
		{ type: MSG.markerCaptured, bootstrap: { port: 4317 } },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(sessionSet).not.toHaveBeenCalled();
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("ignores a marker-captured message whose bootstrap is a DaemonHandle carrying a spurious agentIdentity (no token)", async () => {
	// Same corrupted-shape case as chat-marker.spec.ts's paired test: pid+agentIdentity,
	// no token, must not be relayed into storage.session as a half-filled bootstrap.
	const { api, sessionSet, tabsCreate, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api });
	const listener = getOnMessage();
	const daemonWithAgentIdentity = {
		pid: 4242,
		port: 4317,
		instanceId: "instance-1",
		versions: { package: "1.0.0", protocol: 1 },
		agentIdentity: "claude-orchestrator",
	};

	listener?.(
		{ type: MSG.markerCaptured, bootstrap: daemonWithAgentIdentity },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(sessionSet).not.toHaveBeenCalled();
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("ignores an otherwise well-formed bootstrap whose port falls outside the daemon's ratified range", async () => {
	// The content script matches every loopback port; any page on 127.0.0.1 could
	// forge a bootstrap pointing this socket at an arbitrary local port otherwise.
	const { api, sessionSet, tabsCreate, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api });
	const listener = getOnMessage();
	const outOfRange = makeBootstrap({ port: 9999 });

	listener?.(
		{ type: MSG.markerCaptured, bootstrap: outOfRange },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(sessionSet).not.toHaveBeenCalled();
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("regression: a pending recording still starts from the toolbar action, and chat does not also open", async () => {
	const { api, tabsCreate, getOnClicked } = makeBrowserApi();
	const maybeStartRecording = mock((_tab?: chrome.tabs.Tab) =>
		Promise.resolve(true),
	);
	registerChat({ browserApi: api, maybeStartRecording });
	const onClicked = getOnClicked();
	expect(typeof onClicked).toBe("function");
	const tab = { id: 7 } as chrome.tabs.Tab;

	onClicked?.(tab);
	await settle();

	expect(maybeStartRecording).toHaveBeenCalledWith(tab);
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("regression: the toolbar action opens chat when there is no pending recording", async () => {
	const { api, tabsCreate, getOnClicked } = makeBrowserApi();
	const maybeStartRecording = mock((_tab?: chrome.tabs.Tab) =>
		Promise.resolve(false),
	);
	registerChat({ browserApi: api, maybeStartRecording });
	const onClicked = getOnClicked();
	const tab = { id: 7 } as chrome.tabs.Tab;

	onClicked?.(tab);
	await settle();

	expect(maybeStartRecording).toHaveBeenCalledWith(tab);
	expect(tabsCreate).toHaveBeenCalledWith({
		url: api.runtime.getURL(CHAT_PAGE_PATH),
	});
});

test("regression: registerChat wires exactly one action.onClicked listener, never a second independent one", () => {
	const { api } = makeBrowserApi();
	registerChat({ browserApi: api });
	expect(api.action.onClicked.addListener).toHaveBeenCalledTimes(1);
});

test("registerChat's default browser-api seam registers the toolbar listener on Firefox's MV2 global (browserAction, no action)", () => {
	// WXT's firefox-mv2 build exposes `browser_action`, never MV3's `action` —
	// exercises the un-injected seam that shipped broken (plan.md Layer-1 QA #1).
	const mv2Browser = mockedBrowser as Record<string, unknown>;
	const addListener = mock(() => undefined);
	mv2Browser.browserAction = { onClicked: { addListener } };
	mv2Browser.runtime = {
		onMessage: { addListener: mock(() => undefined) },
		getURL: mock((path: string) => path),
	};
	try {
		expect(() => registerChat()).not.toThrow();
		expect(addListener).toHaveBeenCalledTimes(1);
	} finally {
		delete mv2Browser.browserAction;
		delete mv2Browser.runtime;
	}
});

test("regression: lib/background/recording.ts no longer registers its own action.onClicked listener", () => {
	// Two listeners would both fire on a click — proves the removal side of the
	// Engineering checklist, not just registerChat's own single-registration.
	const source = readFileSync(
		fileURLToPath(new URL("../lib/background/recording.ts", import.meta.url)),
		"utf8",
	);
	expect(source).not.toMatch(/action\.onClicked/);
});

// --- Socket ownership: registerChat delegates to createChatClient (plan.md's
// Layer-2 ratification — "exactly ONE socket implementation"). ---

type FakeSocket = {
	send: ReturnType<typeof mock>;
	addEventListener: ReturnType<typeof mock>;
	dispatch(type: string, event?: unknown): void;
};

function makeFakeSocket(): FakeSocket {
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

function message(frame: Record<string, unknown>) {
	return { data: JSON.stringify(frame) };
}

function buildSessionListFrame(
	sessionId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "session-list",
		sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		sessions: [],
		...overrides,
	};
}

function sentTypes(socket: FakeSocket): string[] {
	return socket.send.mock.calls.map(
		([raw]) => (JSON.parse(raw as string) as { type: string }).type,
	);
}

async function captureMarker(
	getOnMessage: () => Listener | undefined,
	bootstrap: SessionBootstrap,
): Promise<void> {
	getOnMessage()?.(
		{ type: MSG.markerCaptured, bootstrap },
		{},
		mock(() => undefined),
	);
	await settle();
}

test("sends no keepalive before the daemon confirms this session's connect handshake", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	await captureMarker(getOnMessage, makeBootstrap());

	socket.dispatch("open");
	await settle();
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(sentTypes(socket)).not.toContain("keepalive");
});

test("sends a keepalive immediately once the daemon confirms the session, then periodically after", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();
	socket.dispatch(
		"message",
		message(buildSessionListFrame(bootstrap.sessionId)),
	);

	const sentAfterConfirm = sentTypes(socket).filter((t) => t === "keepalive");
	expect(sentAfterConfirm.length).toBeGreaterThan(0);

	await new Promise((resolve) => setTimeout(resolve, 70));
	const sentAfterInterval = sentTypes(socket).filter((t) => t === "keepalive");
	expect(sentAfterInterval.length).toBeGreaterThan(sentAfterConfirm.length);
});

test("the production default keepalive interval is at most 20s, not just an overridable option", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	const realSetInterval = globalThis.setInterval;
	let requestedMs: number | undefined;
	// Spy without scheduling for real — a genuine 20s timer would dangle past
	// this test and keep the process alive; only the requested delay matters here.
	globalThis.setInterval = ((_fn: () => void, ms?: number) => {
		requestedMs = ms;
		return 0 as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	try {
		registerChat({ browserApi: api, openSocket });
		const bootstrap = makeBootstrap();
		await captureMarker(getOnMessage, bootstrap);
		socket.dispatch("open");
		await settle();
		socket.dispatch(
			"message",
			message(buildSessionListFrame(bootstrap.sessionId)),
		);
	} finally {
		globalThis.setInterval = realSetInterval;
	}

	expect(requestedMs).toBeLessThanOrEqual(20_000);
});

test("the first frame sent on open is the connect capability handshake carrying the bootstrap's sessionId+token", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();

	expect(socket.send.mock.calls.length).toBeGreaterThan(0);
	const [rawFrame] = socket.send.mock.calls[0] as [string];
	const parsed = JSON.parse(rawFrame);
	expect(parsed).toEqual({
		type: "connect",
		sessionId: bootstrap.sessionId,
		token: bootstrap.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	});
});

test("the keepalive frames are real ratified ChatFrames, not ad-hoc pings the daemon would reject", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();
	socket.dispatch(
		"message",
		message(buildSessionListFrame(bootstrap.sessionId)),
	);
	await new Promise((resolve) => setTimeout(resolve, 40));

	const keepaliveFrames = socket.send.mock.calls
		.map(([raw]) => JSON.parse(raw as string))
		.filter((f) => f.type === "keepalive");
	expect(keepaliveFrames.length).toBeGreaterThan(0);
	for (const parsed of keepaliveFrames) {
		// Real production validator from @dg/common — catches wire-format drift
		// between this seam and the daemon's own parser, not a re-implemented shape check.
		expect(() => validateChatFrame(parsed)).not.toThrow();
		expect(parsed).toEqual({
			type: "keepalive",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		});
	}
});

test("sends the first keepalive frame immediately once the daemon confirms the session, without waiting a full interval", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 10_000 });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();
	const sentBeforeConfirm = socket.send.mock.calls.length;

	socket.dispatch(
		"message",
		message(buildSessionListFrame(bootstrap.sessionId)),
	);

	const sentAfterConfirm = sentTypes(socket).slice(sentBeforeConfirm);
	expect(sentAfterConfirm).toContain("keepalive");
});

test("opens the WebSocket at the bootstrap's own port, never a hardcoded one", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	// Within the daemon's ratified fallback range but not the default port itself.
	const bootstrap = makeBootstrap({ port: CHAT_DEFAULT_PORT + 3 });

	await captureMarker(getOnMessage, bootstrap);

	expect(openSocket).toHaveBeenCalledWith(
		`ws://127.0.0.1:${CHAT_DEFAULT_PORT + 3}/ws`,
	);
});

test("keepalive stops once the socket reports itself closed, leaving no dangling timer", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();
	socket.dispatch(
		"message",
		message(buildSessionListFrame(bootstrap.sessionId)),
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const sentBeforeClose = socket.send.mock.calls.length;
	expect(sentBeforeClose).toBeGreaterThan(0);

	socket.dispatch("close");
	await new Promise((resolve) => setTimeout(resolve, 50));

	// A leaked timer would keep incrementing this past the close event.
	expect(socket.send.mock.calls.length).toBe(sentBeforeClose);
});

test("keepalive stops once the socket reports an error, leaving no dangling timer", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();
	socket.dispatch(
		"message",
		message(buildSessionListFrame(bootstrap.sessionId)),
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const sentBeforeError = socket.send.mock.calls.length;
	expect(sentBeforeError).toBeGreaterThan(0);

	socket.dispatch("error");
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(socket.send.mock.calls.length).toBe(sentBeforeError);
});

// --- Regression (finding 2): the background socket must not merely open —
// it must actually demux inbound frames, with no chat tab ever attached. ---

test("regression: with no chat tab attached, an inbound frame for a captured session still reaches the client's demux", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	const client = registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	socket.dispatch("open");
	await settle();

	const received: unknown[] = [];
	client.onFrame((frame) => received.push(frame));

	socket.dispatch(
		"message",
		message({
			type: "agent-message",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			body: "hello while the tab is closed",
		}),
	);

	expect(received).toHaveLength(1);
	expect((received[0] as { body: string }).body).toBe(
		"hello while the tab is closed",
	);
});

// --- Regression (finding 9): the background's own real path reconnects,
// rediscovers a relocated daemon, and backs off with a bounded, jittered delay. ---

/** Promise-only microtask flush — safe to use even while setTimeout is mocked. */
async function flushMicrotasks(times = 40): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

test("regression: the background's socket reopens automatically after the daemon connection drops", async () => {
	const sockets: FakeSocket[] = [];
	const openSocket = mock((_url: string) => {
		const s = makeFakeSocket();
		sockets.push(s);
		return s;
	});
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			({ ok: false }) as unknown as Response) as unknown as typeof fetch,
	);

	// registerChat + marker capture first, under the REAL setTimeout — settle()
	// (used by captureMarker) would hang forever once setTimeout is mocked below.
	const { api, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api, openSocket });
	await captureMarker(getOnMessage, makeBootstrap());

	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	try {
		sockets[0]?.dispatch("open");
		sockets[0]?.dispatch("close");

		expect(scheduled.length).toBe(1);
		scheduled[0]?.();
		await flushMicrotasks();

		expect(sockets.length).toBe(2);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("regression: the background rediscovers a relocated daemon via GET /health, preferring the matching instanceId over a decoy", async () => {
	const sockets: FakeSocket[] = [];
	const openSocket = mock((_url: string) => {
		const s = makeFakeSocket();
		sockets.push(s);
		return s;
	});

	const decoyPort = CHAT_DEFAULT_PORT + 1;
	const relocatedPort = CHAT_DEFAULT_PORT + 3;
	let daemonRestarted = false;
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		url: string,
	) => {
		const port = Number(/:(\d+)\/health$/.exec(url)?.[1]);
		if (!daemonRestarted) {
			if (port === CHAT_DEFAULT_PORT) {
				return {
					ok: true,
					json: async () => ({ daemon: "dg-server", instanceId: "inst-fixed" }),
				} as unknown as Response;
			}
			return { ok: false } as unknown as Response;
		}
		if (port === decoyPort) {
			return {
				ok: true,
				json: async () => ({ daemon: "dg-server", instanceId: "inst-other" }),
			} as unknown as Response;
		}
		if (port === relocatedPort) {
			return {
				ok: true,
				json: async () => ({ daemon: "dg-server", instanceId: "inst-fixed" }),
			} as unknown as Response;
		}
		return { ok: false } as unknown as Response;
	}) as unknown as typeof fetch);

	const { api, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api, openSocket });
	await captureMarker(getOnMessage, makeBootstrap({ port: CHAT_DEFAULT_PORT }));

	sockets[0]?.dispatch("open");
	await flushMicrotasks(); // let handleOpen's fire-and-forget /health lookup learn "inst-fixed"

	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	try {
		daemonRestarted = true;
		sockets[0]?.dispatch("close");

		expect(scheduled.length).toBe(1);
		scheduled[0]?.();
		await flushMicrotasks(); // rediscovery scans candidate ports sequentially via awaited /health calls

		expect(sockets.length).toBe(2);
		expect(openSocket).toHaveBeenLastCalledWith(
			`ws://127.0.0.1:${relocatedPort}/ws`,
		);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("regression: the background's reconnect backoff grows across attempts and stays bounded", async () => {
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	const { api, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api, openSocket });
	await captureMarker(getOnMessage, makeBootstrap());

	const delays: number[] = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
		delays.push(ms ?? 0);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	try {
		socket.dispatch("close");
		socket.dispatch("close");
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}

	expect(delays.length).toBeGreaterThanOrEqual(2);
	// Doubling the base each attempt dominates jitter's bounded [0,1) range, so
	// growth holds regardless of the draw — no jitter override needed to assert it.
	expect(delays[1]).toBeGreaterThan(delays[0] as number);
	for (const d of delays) expect(d).toBeLessThanOrEqual(30_000);
});

test("a closed session stops drawing keepalives, so its dead token cannot burn the shared socket's budget", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const closing = makeBootstrap({ sessionId: "sess-closing", token: "tok-closing" });
	const staying = makeBootstrap({ sessionId: "sess-staying", token: "tok-staying" });
	await captureMarker(getOnMessage, closing);
	await captureMarker(getOnMessage, staying);

	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(closing.sessionId)));
	socket.dispatch("message", message(buildSessionListFrame(staying.sessionId)));
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: closing.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();
	const sentBefore = socket.send.mock.calls.length;

	await new Promise((resolve) => setTimeout(resolve, 70));

	// One socket serves every session, so a keepalive for the closed one would
	// spend the failed-frame budget that disconnects the sessions still open.
	const tokensAfter = socket.send.mock.calls
		.slice(sentBefore)
		.map(([raw]) => (JSON.parse(raw as string) as { token?: string }).token);
	expect(tokensAfter).not.toContain(closing.token);
	expect(tokensAfter).toContain(staying.token);
});

test("regression: registerRecording still wires its message router, unaffected by the removed onClicked registration", () => {
	const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	// Deliberately no `action` field: if registerRecording still tried to touch
	// chrome.action.onClicked, this would throw instead of silently passing.
	const onMessageAddListener = mock(() => undefined);
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: { runtime: { onMessage: { addListener: onMessageAddListener } } },
	});
	try {
		expect(() => registerRecording()).not.toThrow();
		expect(onMessageAddListener).toHaveBeenCalledTimes(1);
	} finally {
		if (originalChrome) {
			Object.defineProperty(globalThis, "chrome", originalChrome);
		} else {
			Reflect.deleteProperty(globalThis, "chrome");
		}
	}
});
