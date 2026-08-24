import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
	validateChatFrame,
} from "@dg/common";
import { CHAT_PAGE_PATH, CHAT_SESSION_KEY_PREFIX } from "@/lib/background/chat";
import { buildSessionListFrame as buildSessionListFrameShared } from "./utils/frame-fixtures";
import {
	captureGlobal,
	type FakeSocket,
	flushMicrotasks,
	makeBootstrapFactory,
	makeFakeSocket,
	frameEvent as message,
	settle,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerChat, registerRecording } = await import("@/lib/background");
const { MSG } = await import("@/lib/chat-messages");
const { browser: mockedBrowser } = await import("wxt/browser");

const makeBootstrap = makeBootstrapFactory({
	port: CHAT_DEFAULT_PORT,
	sessionId: "sess-abc123",
	token: "tok-xyz789",
	agentIdentity: "claude-orchestrator",
});

function buildSessionListFrame(
	sessionId: string,
	overrides: Record<string, unknown> = {},
) {
	return buildSessionListFrameShared([], { sessionId, ...overrides });
}

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
	const sessionRemove = mock((_keys: string | string[]) => Promise.resolve());
	const tabsCreate = mock((_props: { url: string }) => Promise.resolve());
	const sendMessage = mock((_message: unknown) => Promise.resolve(undefined));
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
			sendMessage,
		},
		tabs: { create: tabsCreate },
		storage: { session: { set: sessionSet, remove: sessionRemove } },
	};
	return {
		api,
		sessionSet,
		sessionRemove,
		tabsCreate,
		sendMessage,
		getOnMessage: () => onMessageListener,
		getOnClicked: () => onClickedListener,
	};
}

function extensionPageSender(api: ReturnType<typeof makeBrowserApi>["api"]) {
	return { url: api.runtime.getURL("chat.html") };
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
	const source = readFileSync(
		fileURLToPath(new URL("../lib/background/recording.ts", import.meta.url)),
		"utf8",
	);
	expect(source).not.toMatch(/action\.onClicked/);
});

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
					json: async () => ({ daemon: "dg-daemon", instanceId: "inst-fixed" }),
				} as unknown as Response;
			}
			return { ok: false } as unknown as Response;
		}
		if (port === decoyPort) {
			return {
				ok: true,
				json: async () => ({ daemon: "dg-daemon", instanceId: "inst-other" }),
			} as unknown as Response;
		}
		if (port === relocatedPort) {
			return {
				ok: true,
				json: async () => ({ daemon: "dg-daemon", instanceId: "inst-fixed" }),
			} as unknown as Response;
		}
		return { ok: false } as unknown as Response;
	}) as unknown as typeof fetch);

	const { api, getOnMessage } = makeBrowserApi();
	registerChat({ browserApi: api, openSocket });
	await captureMarker(getOnMessage, makeBootstrap({ port: CHAT_DEFAULT_PORT }));

	sockets[0]?.dispatch("open");
	await flushMicrotasks();

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
		await flushMicrotasks();

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
	expect(delays[1]).toBeGreaterThan(delays[0] as number);
	for (const d of delays) expect(d).toBeLessThanOrEqual(30_000);
});

test("a closed session stops drawing keepalives, so its dead token cannot burn the shared socket's budget", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const closing = makeBootstrap({
		sessionId: "sess-closing",
		token: "tok-closing",
	});
	const staying = makeBootstrap({
		sessionId: "sess-staying",
		token: "tok-staying",
	});
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

	const tokensAfter = socket.send.mock.calls
		.slice(sentBefore)
		.map(([raw]) => (JSON.parse(raw as string) as { token?: string }).token);
	expect(tokensAfter).not.toContain(closing.token);
	expect(tokensAfter).toContain(staying.token);
});

test("regression: a session created via session-pending is registered for keepalive, not silently dropped", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const requester = makeBootstrap();
	await captureMarker(getOnMessage, requester);

	socket.dispatch("open");
	await settle();
	socket.dispatch(
		"message",
		message(buildSessionListFrame(requester.sessionId)),
	);
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "session-pending",
			sessionId: requester.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			newSession: { sessionId: "sess-spawned", token: "tok-spawned" },
		}),
	);
	socket.dispatch("message", message(buildSessionListFrame("sess-spawned")));
	await new Promise((resolve) => setTimeout(resolve, 40));

	const tokens = socket.send.mock.calls
		.map(
			([raw]) => JSON.parse(raw as string) as { type: string; token?: string },
		)
		.filter((f) => f.type === "keepalive")
		.map((f) => f.token);
	expect(tokens).toContain("tok-spawned");
});

test("MSG.clientConnect from an extension page connects the client and responds with the connection state", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	const sendResponse = mock((_r: unknown) => undefined);

	getOnMessage()?.(
		{ type: MSG.clientConnect, bootstrap },
		extensionPageSender(api),
		sendResponse,
	);
	await settle();

	expect(openSocket).toHaveBeenCalledWith(
		`ws://127.0.0.1:${bootstrap.port}/ws`,
	);
	expect(sendResponse).toHaveBeenCalledWith(
		expect.objectContaining({ ok: true }),
	);
});

test("MSG.clientConnect from a non-extension-page sender is refused without connecting", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	const sendResponse = mock((_r: unknown) => undefined);

	getOnMessage()?.(
		{ type: MSG.clientConnect, bootstrap },
		{ url: "http://example.com/evil", tab: { id: 9 } },
		sendResponse,
	);
	await settle();

	expect(openSocket).not.toHaveBeenCalled();
	expect(sendResponse).not.toHaveBeenCalled();
});

test("MSG.userMessage relays to the daemon as a real user-message frame and acks the sender", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	const sendResponse = mock((_r: unknown) => undefined);

	getOnMessage()?.(
		{ type: MSG.userMessage, sessionId: bootstrap.sessionId, body: "hello" },
		extensionPageSender(api),
		sendResponse,
	);
	await settle();

	const sent = socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
	expect(
		sent.some((f) => f.type === "user-message" && f.body === "hello"),
	).toBe(true);
	expect(sendResponse).toHaveBeenCalledWith({ ok: true });
});

test("MSG.sessionCreate relays to the daemon as a real session-create frame", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	const sendResponse = mock((_r: unknown) => undefined);

	getOnMessage()?.(
		{ type: MSG.sessionCreate, sessionId: bootstrap.sessionId, role: "agent" },
		extensionPageSender(api),
		sendResponse,
	);
	await settle();

	const sent = socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
	expect(sent.some((f) => f.type === "session-create")).toBe(true);
	expect(sendResponse).toHaveBeenCalledWith({ ok: true });
});

test("MSG.sessionClose relays to the daemon as a real session-close frame", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	const sendResponse = mock((_r: unknown) => undefined);

	getOnMessage()?.(
		{ type: MSG.sessionClose, sessionId: bootstrap.sessionId },
		extensionPageSender(api),
		sendResponse,
	);
	await settle();

	const sent = socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
	expect(sent.some((f) => f.type === "session-close")).toBe(true);
	expect(sendResponse).toHaveBeenCalledWith({ ok: true });
});

test("every daemon frame is broadcast outward via api.runtime.sendMessage, not just relied on to no-op", async () => {
	const { api, sendMessage, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "agent-message",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			body: "hi from the daemon",
		}),
	);

	expect(sendMessage).toHaveBeenCalledWith({
		type: MSG.frame,
		frame: expect.objectContaining({ type: "agent-message" }),
	});
});

test("regression: registerRecording still wires its message router, unaffected by the removed onClicked registration", () => {
	const restoreChrome = captureGlobal("chrome");
	const onMessageAddListener = mock(() => undefined);
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: { runtime: { onMessage: { addListener: onMessageAddListener } } },
	});
	try {
		expect(() => registerRecording()).not.toThrow();
		expect(onMessageAddListener).toHaveBeenCalledTimes(1);
	} finally {
		restoreChrome();
	}
});

test("a closed session's bootstrap is removed from storage.session, so the next chat page never re-handshakes a dead capability", async () => {
	const { api, sessionRemove, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();

	expect(sessionRemove).toHaveBeenCalledWith(
		`${CHAT_SESSION_KEY_PREFIX}${bootstrap.sessionId}`,
	);
});
