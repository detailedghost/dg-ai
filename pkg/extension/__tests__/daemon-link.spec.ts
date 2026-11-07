import { describe, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CHAT_DEFAULT_PORT,
	clearNotedSecrets,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type SessionBootstrap,
	validateChatFrame,
} from "@dg/common";
import { handleOverwatchFrameSafely } from "@/lib/background/pages";
import { buildSessionListFrame as buildSessionListFrameShared } from "./utils/frame-fixtures";
import {
	captureGlobal,
	type FakeSocket,
	flushMicrotasks,
	makeBootstrapFactory,
	makeFakeSocket,
	frameEvent as message,
	type LocalArea,
	makeLocalArea,
	makeStorage,
	settle,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerDaemonLink, registerRecording } = await import("@/lib/background");
const { MSG } = await import("@dg/pages/chat-messages");
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

const pairingKey = (sessionId: string) => `pairing:${sessionId}`;

function makeBrowserApi(local: LocalArea = makeLocalArea()) {
	let onMessageListener: Listener | undefined;
	let onClickedListener: ClickListener | undefined;
	const tabsCreate = mock((_props: { url: string }) => Promise.resolve());
	const tabsQuery = mock((_queryInfo: object) =>
		Promise.resolve([] as { id?: number; windowId?: number; url?: string }[]),
	);
	const tabsUpdate = mock((_tabId: number, _props: { active: boolean }) =>
		Promise.resolve(),
	);
	const windowsUpdate = mock((_windowId: number, _props: { focused: boolean }) =>
		Promise.resolve(),
	);
	const sendMessage = mock((_message: unknown) => Promise.resolve(undefined));
	const openOptionsPage = mock(() => Promise.resolve());
	const onStartupAdd = mock((_cb: () => void) => undefined);
	const onInstalledAdd = mock((_cb: () => void) => undefined);
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
			getManifest: () => ({ version: "1.9.3" }),
			sendMessage,
			openOptionsPage,
			onStartup: { addListener: onStartupAdd },
			onInstalled: { addListener: onInstalledAdd },
		},
		tabs: { create: tabsCreate, query: tabsQuery, update: tabsUpdate },
		windows: { update: windowsUpdate },
		storage: makeStorage(local),
	};
	return {
		api,
		local,
		onStartupAdd,
		onInstalledAdd,
		tabsCreate,
		tabsQuery,
		tabsUpdate,
		windowsUpdate,
		sendMessage,
		openOptionsPage,
		getOnMessage: () => onMessageListener,
		getOnClicked: () => onClickedListener,
	};
}

function extensionPageSender(api: ReturnType<typeof makeBrowserApi>["api"]) {
	return { url: api.runtime.getURL("options.html") };
}

test("registerDaemonLink is exported as a function from the background barrel", () => {
	expect(typeof registerDaemonLink).toBe("function");
});

test("the background entrypoint imports registerDaemonLink from the barrel and invokes it", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../entrypoints/background.ts", import.meta.url)),
		"utf8",
	);
	expect(source).toMatch(
		/import\s*\{[^}]*\bregisterDaemonLink\b[^}]*\}\s*from\s*["']@\/lib\/background["']/,
	);
	expect(source).toMatch(/registerDaemonLink\s*\(/);
});

test("a captured marker acknowledges connection setup and opens no tab", async () => {
	const { api, tabsCreate, getOnMessage } = makeBrowserApi();
	registerDaemonLink({ browserApi: api, openSocket: () => makeFakeSocket() });
	const listener = getOnMessage();
	expect(typeof listener).toBe("function");
	const sendResponse = mock(() => undefined);

	const keepChannel = listener?.(
		{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
		{},
		sendResponse,
	);
	await settle();

	expect(keepChannel).toBe(true);
	expect(sendResponse).toHaveBeenCalledWith({ ok: true });
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("a pairing write that fails when the session confirms does not stop that session's keepalive", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	local.set.mockImplementation(() => Promise.reject(new Error("storage failed")));
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();

	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();

	const types = socket.send.mock.calls.map(
		([raw]) => (JSON.parse(raw as string) as { type: string }).type,
	);
	expect(types).toContain("keepalive");
});

test("ignores a marker-captured message carrying a malformed bootstrap rather than partially storing it", async () => {
	const { api, local, tabsCreate, getOnMessage } = makeBrowserApi();
	registerDaemonLink({ browserApi: api });
	const listener = getOnMessage();

	listener?.(
		{ type: MSG.markerCaptured, bootstrap: { port: 4317 } },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(local.set).not.toHaveBeenCalled();
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("ignores a marker-captured message whose bootstrap is a DaemonHandle carrying a spurious agentIdentity (no token)", async () => {
	const { api, local, tabsCreate, getOnMessage } = makeBrowserApi();
	registerDaemonLink({ browserApi: api });
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

	expect(local.set).not.toHaveBeenCalled();
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("ignores an otherwise well-formed bootstrap whose port falls outside the daemon's ratified range", async () => {
	const { api, local, tabsCreate, getOnMessage } = makeBrowserApi();
	registerDaemonLink({ browserApi: api });
	const listener = getOnMessage();
	const outOfRange = makeBootstrap({ port: 9999 });

	listener?.(
		{ type: MSG.markerCaptured, bootstrap: outOfRange },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(local.set).not.toHaveBeenCalled();
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("regression: a pending recording still starts from the toolbar action, and settings do not also open", async () => {
	const { api, openOptionsPage, getOnClicked } = makeBrowserApi();
	const maybeStartRecording = mock((_tab?: chrome.tabs.Tab) =>
		Promise.resolve(true),
	);
	registerDaemonLink({ browserApi: api, maybeStartRecording });
	const onClicked = getOnClicked();
	expect(typeof onClicked).toBe("function");
	const tab = { id: 7 } as chrome.tabs.Tab;

	onClicked?.(tab);
	await settle();

	expect(maybeStartRecording).toHaveBeenCalledWith(tab);
	expect(openOptionsPage).not.toHaveBeenCalled();
});

test("regression: the toolbar action opens settings when there is no pending recording", async () => {
	const { api, openOptionsPage, getOnClicked } = makeBrowserApi();
	const maybeStartRecording = mock((_tab?: chrome.tabs.Tab) =>
		Promise.resolve(false),
	);
	registerDaemonLink({ browserApi: api, maybeStartRecording });
	const onClicked = getOnClicked();
	const tab = { id: 7 } as chrome.tabs.Tab;

	onClicked?.(tab);
	await settle();

	expect(maybeStartRecording).toHaveBeenCalledWith(tab);
	expect(openOptionsPage).toHaveBeenCalledTimes(1);
});

test("regression: registerDaemonLink wires exactly one action.onClicked listener, never a second independent one", () => {
	const { api } = makeBrowserApi();
	registerDaemonLink({ browserApi: api });
	expect(api.action.onClicked.addListener).toHaveBeenCalledTimes(1);
});

test("registerDaemonLink's default browser-api seam registers the toolbar listener on Firefox's MV2 global (browserAction, no action)", () => {
	const mv2Browser = mockedBrowser as Record<string, unknown>;
	const addListener = mock(() => undefined);
	mv2Browser.browserAction = { onClicked: { addListener } };
	mv2Browser.runtime = {
		onMessage: { addListener: mock(() => undefined) },
		getURL: mock((path: string) => path),
	};
	try {
		expect(() => registerDaemonLink()).not.toThrow();
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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
		registerDaemonLink({ browserApi: api, openSocket });
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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
		extensionVersion: "1.9.3",
	});
});

test("the keepalive frames are real ratified ChatFrames, not ad-hoc pings the daemon would reject", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 10_000 });
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
	registerDaemonLink({ browserApi: api, openSocket });
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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
	const client = registerDaemonLink({ browserApi: api, openSocket });
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

test("reports an overwatch open failure from the browser API", async () => {
	const { api, tabsCreate } = makeBrowserApi();
	const error = spyOn(console, "error").mockImplementation(() => undefined);
	tabsCreate.mockImplementation(() => Promise.reject(new Error("tab failed")));

	try {
		await handleOverwatchFrameSafely(
			{
				type: "overwatch-open",
				sessionId: OVERWATCH_SESSION_ID,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "open-request-1",
			},
			api,
			{ bootstrap: makeBootstrap(), complete: () => undefined },
		);

		expect(error).toHaveBeenCalledWith(
			"[dg-ai-extension] overwatch frame failed: tab failed",
		);
	} finally {
		error.mockRestore();
	}
});

test("an inbound overwatch-open focuses the existing board tab and replies to the daemon", async () => {
	const {
		api,
		getOnMessage,
		tabsCreate,
		tabsQuery,
		tabsUpdate,
		windowsUpdate,
	} = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	tabsQuery.mockImplementation(() =>
		Promise.resolve([
			{ id: 41, windowId: 7, url: `http://127.0.0.1:${bootstrap.port}/board` },
		]),
	);
	const tabsCreatedBeforeOpen = tabsCreate.mock.calls.length;

	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	socket.dispatch(
		"message",
		message({
			type: "overwatch-open",
			sessionId: OVERWATCH_SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "open-request-1",
		}),
	);
	await settle();

	expect(tabsUpdate).toHaveBeenCalledWith(41, { active: true });
	expect(windowsUpdate).toHaveBeenCalledWith(7, { focused: true });
	expect(tabsCreate).toHaveBeenCalledTimes(tabsCreatedBeforeOpen);
	expect(
		socket.send.mock.calls
			.map(([raw]) => JSON.parse(raw as string))
			.find((frame) => frame.type === "overwatch-open-result"),
	).toEqual({
		type: "overwatch-open-result",
		sessionId: bootstrap.sessionId,
		token: bootstrap.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "open-request-1",
		ok: true,
	});
});

test("an overwatch-open completion waits for the replacement socket handshake after a disconnect", async () => {
	const sockets: FakeSocket[] = [];
	const openSocket = mock((_url: string) => {
		const socket = makeFakeSocket();
		sockets.push(socket);
		return socket;
	});
	const { api, getOnMessage, tabsQuery } = makeBrowserApi();
	let resolveQuery:
		| ((matches: { id?: number; windowId?: number; url?: string }[]) => void)
		| undefined;
	tabsQuery.mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveQuery = resolve;
			}),
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			({ ok: false }) as unknown as Response) as unknown as typeof fetch,
	);
	registerDaemonLink({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);

	sockets[0]?.dispatch("open");
	await settle();
	sockets[0]?.dispatch(
		"message",
		message(buildSessionListFrame(bootstrap.sessionId)),
	);
	await settle();
	sockets[0]?.dispatch(
		"message",
		message({
			type: "overwatch-open",
			sessionId: OVERWATCH_SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "open-request-after-reconnect",
		}),
	);
	await flushMicrotasks();
	expect(resolveQuery).toBeDefined();

	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	try {
		sockets[0]?.dispatch("close");
		scheduled.shift()?.();
		await flushMicrotasks();
		sockets[1]?.dispatch("open");
		resolveQuery?.([]);
		await flushMicrotasks();

		expect(
			sockets[0]?.send.mock.calls.some(
				([raw]) => JSON.parse(raw as string).type === "overwatch-open-result",
			),
		).toBe(false);
		expect(
			sockets[1]?.send.mock.calls.some(
				([raw]) => JSON.parse(raw as string).type === "overwatch-open-result",
			),
		).toBe(false);

		sockets[1]?.dispatch(
			"message",
			message(buildSessionListFrame(bootstrap.sessionId)),
		);
		await flushMicrotasks();

		expect(
			sockets[1]?.send.mock.calls
				.map(([raw]) => JSON.parse(raw as string))
				.find((frame) => frame.type === "overwatch-open-result"),
		).toEqual({
			type: "overwatch-open-result",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "open-request-after-reconnect",
			ok: true,
		});
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
});

test("registerDaemonLink drops a pw-ext result whose admission socket was replaced by a reconnect", async () => {
	const sockets: FakeSocket[] = [];
	const openSocket = mock((_url: string) => {
		const socket = makeFakeSocket();
		sockets.push(socket);
		return socket;
	});
	const { api, getOnMessage } = makeBrowserApi();
	const bootstrap = makeBootstrap();
	let finish: ((body: { ok: true; data: unknown }) => void) | undefined;
	const pwExtRun = mock(
		() =>
			new Promise<{ ok: true; data: unknown }>((resolve) => {
				finish = resolve;
			}),
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			({ ok: false }) as unknown as Response) as unknown as typeof fetch,
	);
	registerDaemonLink({ browserApi: api, openSocket, relayHandlers: { "pw-ext": pwExtRun as never } });
	await captureMarker(getOnMessage, bootstrap);
	sockets[0]?.dispatch("open");
	await settle();
	sockets[0]?.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	sockets[0]?.dispatch(
		"message",
		message({
			type: "pw-ext-browser-request",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "pw-replaced",
			request: { verb: "current" },
			timeoutMs: 60_000,
		}),
	);
	await settle();
	expect(pwExtRun).toHaveBeenCalledTimes(1);

	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		if (ms !== 60_000) scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	try {
		sockets[0]?.dispatch("close");
		scheduled.shift()?.();
		await flushMicrotasks();
		sockets[1]?.dispatch("open");
		await flushMicrotasks();
		sockets[1]?.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
		await flushMicrotasks();
	} finally {
		globalThis.setTimeout = realSetTimeout;
		fetchSpy.mockRestore();
	}
	expect(sockets).toHaveLength(2);
	finish?.({ ok: true, data: {} });
	await flushMicrotasks();

	for (const socket of sockets) {
		expect(
			socket.send.mock.calls.some(
				([raw]) => JSON.parse(raw as string).type === "pw-ext-browser-result",
			),
		).toBe(false);
	}
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
	registerDaemonLink({ browserApi: api, openSocket });
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

test("regression: the background rediscovers a relocated daemon via GET /healthz, preferring the matching instanceId over a decoy", async () => {
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
		const port = Number(/:(\d+)\/healthz$/.exec(url)?.[1]);
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
	registerDaemonLink({ browserApi: api, openSocket });
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
	registerDaemonLink({ browserApi: api, openSocket });
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
	registerDaemonLink({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
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

test("MSG.sessionClose relays to the daemon as a real session-close frame", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerDaemonLink({ browserApi: api, openSocket });
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

test("a closed session's bootstrap is removed from local storage, so the next browser start never re-handshakes a dead capability", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerDaemonLink({ browserApi: api, openSocket });
	const bootstrap = makeBootstrap();
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	expect(local.data).toHaveProperty([pairingKey(bootstrap.sessionId)]);

	socket.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();

	expect(local.data).not.toHaveProperty([pairingKey(bootstrap.sessionId)]);
});

test("the background announces the manifest version in its connect handshake", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, makeBootstrap());

	socket.dispatch("open");
	await settle();

	const connect = socket.send.mock.calls
		.map(([raw]) => JSON.parse(raw))
		.find((frame) => frame.type === "connect");
	expect(connect).toMatchObject({ extensionVersion: "1.9.3" });
});

test("a socket error is relayed to the chat page as a connection change with its detail", async () => {
	const { api, getOnMessage, sendMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, makeBootstrap({ port: CHAT_DEFAULT_PORT }));

	socket.dispatch("error");
	await settle();

	expect(sendMessage).toHaveBeenCalledWith({
		type: MSG.connection,
		state: "reconnecting",
		connected: false,
		sessions: [{ sessionId: makeBootstrap().sessionId, agentIdentity: makeBootstrap().agentIdentity, current: true, connected: false }],
		detail: `could not reach the daemon on port ${CHAT_DEFAULT_PORT}`,
	});
});

test("a socket that opens is relayed to the chat page as connected", async () => {
	const { api, getOnMessage, sendMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, makeBootstrap());

	socket.dispatch("open");
	await settle();

	expect(sendMessage).toHaveBeenCalledWith({
		type: MSG.connection,
		state: "connected",
		connected: false,
		sessions: [{ sessionId: makeBootstrap().sessionId, agentIdentity: makeBootstrap().agentIdentity, current: true, connected: false }],
	});
});

async function inboxRelay({ confirm = true, deferred = false } = {}) {
	const { api, getOnMessage, sendMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	let release: (() => void) | undefined;
	const pending = deferred ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
	const handler = mock(async (_input: { request: unknown }) => {
		await pending;
		return { ok: true as const, data: { messages: [], hasMore: false } };
	});
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { inbox: handler as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	if (confirm) socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	const request = { type: "inbox-browser-request", sessionId: bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION, requestId: "inbox-correlated-request",
		request: { operation: "list-messages", page: 0, pageSize: 50 } };
	const results = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter((frame) => frame.type === "inbox-browser-result");
	return { socket, bootstrap, request, handler, sendMessage, release: () => release?.(), results };
}

test("registerDaemonLink sends a correlated authenticated inbox result directly to the daemon socket", async () => {
	const relay = await inboxRelay();
	relay.socket.dispatch("message", message(relay.request));
	await settle();
	expect(relay.handler).toHaveBeenCalledTimes(1);
	expect(relay.results()).toEqual([{ type: "inbox-browser-result", sessionId: relay.bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION, requestId: relay.request.requestId, token: relay.bootstrap.token,
		ok: true, data: { messages: [], hasMore: false } }]);
	expect(() => validateChatFrame(relay.results()[0])).not.toThrow();
	expect(relay.sendMessage.mock.calls.some(([event]) => (event as { frame?: { type: string } }).frame?.type === "inbox-browser-request")).toBe(false);
	expect(sentTypes(relay.socket)).not.toContain("user-message");
});

test("registerDaemonLink suppresses duplicate inbox requests while their provider operation is pending", async () => {
	const relay = await inboxRelay({ deferred: true });
	relay.socket.dispatch("message", message(relay.request));
	relay.socket.dispatch("message", message(relay.request));
	await settle();
	expect(relay.handler).toHaveBeenCalledTimes(1);
	expect(relay.results()).toEqual([]);
	relay.release();
	await settle();
	expect(relay.results()).toHaveLength(1);
});

test("registerDaemonLink rejects inbox execution before the authenticated session handshake is confirmed", async () => {
	const relay = await inboxRelay({ confirm: false });
	relay.socket.dispatch("message", message(relay.request));
	await settle();
	expect(relay.handler).not.toHaveBeenCalled();
	expect(relay.results()).toEqual([]);
});

test("registerDaemonLink rejects inbox requests for an uncaptured session", async () => {
	const relay = await inboxRelay();
	relay.socket.dispatch("message", message({ ...relay.request, sessionId: "uncaptured-session" }));
	await settle();
	expect(relay.handler).not.toHaveBeenCalled();
	expect(relay.results()).toEqual([]);
});

test("registerDaemonLink turns a proto-browser-request onFrame into a proto-browser-result", async () => {
	const { api, getOnMessage, sendMessage, tabsCreate } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();

	const request = {
		type: "proto-browser-request",
		sessionId: bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "proto-correlated-request",
		phase: "scrape",
		slug: "account-summary",
		markedUrl: "https://example.test/account#_proto=fixture",
		timeoutMs: 45_000,
	};
	socket.dispatch("message", message(request));
	await settle();
	await flushMicrotasks();

	const results = socket.send.mock.calls
		.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>)
		.filter((frame) => frame.type === "proto-browser-result");
	expect(
		tabsCreate.mock.calls.map(
			(call) => call[0] as { url: string; active?: boolean },
		),
	).toContainEqual({
		url: request.markedUrl,
		active: true,
	});
	expect(results).toEqual([
		{
			type: "proto-browser-result",
			sessionId: bootstrap.sessionId,
			requestId: request.requestId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			ok: false,
			error: "the extension could not open a tab for this URL",
		},
	]);
	expect(() => validateChatFrame(results[0])).not.toThrow();
	expect(
		sendMessage.mock.calls.some(
			([event]) =>
				(event as { frame?: { type: string } }).frame?.type ===
				"proto-browser-request",
		),
	).toBe(false);
});

test.each(["session-closed", "close", "error"])("registerDaemonLink discards a pending inbox result after %s", async (ending) => {
	const relay = await inboxRelay({ deferred: true });
	relay.socket.dispatch("message", message(relay.request));
	await settle();
	expect(relay.handler).toHaveBeenCalledTimes(1);
	if (ending === "session-closed") relay.socket.dispatch("message", message({ type: ending,
		sessionId: relay.bootstrap.sessionId, protocolVersion: CHAT_PROTOCOL_VERSION }));
	else relay.socket.dispatch(ending);
	relay.release();
	await settle();
	expect(relay.results()).toEqual([]);
});

test("registerDaemonLink aborts a pending pw-ext signal on an error drop", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	const signals: AbortSignal[] = [];
	const pwExt = mock((input: { signal: AbortSignal }) => {
		signals.push(input.signal);
		return new Promise<never>(() => undefined);
	});
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { "pw-ext": pwExt as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	socket.dispatch("message", message({
		type: "pw-ext-browser-request",
		sessionId: bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "pw-drop",
		request: { verb: "current" },
		timeoutMs: 60_000,
	}));
	await settle();
	expect(signals[0]?.aborted).toBe(false);

	const errorFrame = {
		type: "error",
		sessionId: bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		code: "invalid-session",
		message: "unknown session",
	};
	socket.dispatch("message", message(errorFrame));
	await settle();

	expect(signals[0]?.aborted).toBe(true);
});

test("registerDaemonLink turns a pw-ext-browser-request into one tokened pw-ext-browser-result", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	const pwExtRun = mock(async () => ({
		ok: true as const,
		data: { text: "### Page" },
	}));
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { "pw-ext": pwExtRun as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();

	const request = {
		type: "pw-ext-browser-request",
		sessionId: bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "pw-request",
		request: { verb: "current" },
		timeoutMs: 60_000,
	};
	socket.dispatch("message", message(request));
	socket.dispatch("message", message(request));
	await settle();
	await flushMicrotasks();

	expect(pwExtRun.mock.calls).toEqual([
		[
			{
				request: { verb: "current" },
				timeoutMs: 60_000,
				signal: expect.any(AbortSignal),
				progress: expect.any(Function),
				context: expect.objectContaining({
					sessionId: bootstrap.sessionId,
					agentIdentity: bootstrap.agentIdentity,
					fetchAsset: expect.any(Function),
					deleteAsset: expect.any(Function),
				}),
			},
		],
	] as never);
	const results = socket.send.mock.calls
		.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>)
		.filter((frame) => frame.type === "pw-ext-browser-result");
	expect(results).toEqual([
		{
			type: "pw-ext-browser-result",
			ok: true,
			data: { text: "### Page" },
			sessionId: bootstrap.sessionId,
			requestId: "pw-request",
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		},
	]);
	expect(() => validateChatFrame(results[0])).not.toThrow();
});

test("registerDaemonLink ignores a pw-ext request for an unpaired session", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	const pwExtRun = mock(async () => ({ ok: false as const, error: "x" }));
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { "pw-ext": pwExtRun as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	socket.dispatch(
		"message",
		message({
			type: "pw-ext-browser-request",
			sessionId: "other-session",
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "pw-request",
			request: { verb: "current" },
			timeoutMs: 60_000,
		}),
	);
	await settle();
	expect(pwExtRun).not.toHaveBeenCalled();
});

test("registerDaemonLink cancels a pending pw-ext request when its session closes", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	let seen: AbortSignal | undefined;
	const pwExtRun = mock(
		({ signal }: { signal: AbortSignal }) =>
			new Promise<{ ok: false; error: string }>((resolve) => {
				seen = signal;
				signal?.addEventListener("abort", () =>
					resolve({ ok: false, error: "canceled" }),
				);
			}),
	);
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { "pw-ext": pwExtRun as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	socket.dispatch(
		"message",
		message({
			type: "pw-ext-browser-request",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "pw-request",
			request: { verb: "click", target: "e1" },
			timeoutMs: 60_000,
		}),
	);
	await settle();
	expect(seen?.aborted).toBe(false);
	socket.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();
	expect(seen?.aborted).toBe(true);
});

test("registerDaemonLink aborts a pending pw-ext request on a daemon cancel frame", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	let seen: AbortSignal | undefined;
	let context: { fetchAsset(id: string): Promise<Blob> } | undefined;
	const pwExtRun = mock(
		({
			signal,
			context: ctx,
		}: {
			signal: AbortSignal;
			context?: { fetchAsset(id: string): Promise<Blob> };
		}) =>
			new Promise<{ ok: false; error: string }>((resolve) => {
				seen = signal;
				context = ctx;
				signal?.addEventListener("abort", () => resolve({ ok: false, error: "x" }));
			}),
	);
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { "pw-ext": pwExtRun as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	const base = {
		sessionId: bootstrap.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "pw-request",
	};
	socket.dispatch(
		"message",
		message({
			...base,
			type: "pw-ext-browser-request",
			request: { verb: "click", target: "e1" },
			timeoutMs: 60_000,
		}),
	);
	await settle();
	expect(typeof context?.fetchAsset).toBe("function");
	socket.dispatch("message", message({ ...base, requestId: "other", type: "pw-ext-browser-cancel" }));
	await settle();
	expect(seen?.aborted).toBe(false);
	socket.dispatch("message", message({ ...base, type: "pw-ext-browser-cancel" }));
	await settle();
	expect(seen?.aborted).toBe(true);
});

test("registerDaemonLink aborts a pw-ext request at its relay deadline", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const bootstrap = makeBootstrap();
	let seen: AbortSignal | undefined;
	const pwExtRun = mock(
		({ signal }: { signal: AbortSignal }) =>
			new Promise<{ ok: false; error: string }>((resolve) => {
				seen = signal;
				signal?.addEventListener("abort", () => resolve({ ok: false, error: "x" }));
			}),
	);
	registerDaemonLink({ browserApi: api, openSocket: () => socket, relayHandlers: { "pw-ext": pwExtRun as never } });
	await captureMarker(getOnMessage, bootstrap);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(bootstrap.sessionId)));
	await settle();
	socket.dispatch(
		"message",
		message({
			type: "pw-ext-browser-request",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "pw-deadline",
			request: { verb: "current" },
			timeoutMs: 60,
		}),
	);
	await settle();
	expect(seen?.aborted).toBe(false);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(seen?.aborted).toBe(true);
});

type Gate = { promise: Promise<void>; open(): void; fail(error: Error): void };

function makeGate(): Gate {
	let open!: () => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

function storedPairings(...bootstraps: SessionBootstrap[]) {
	return Object.fromEntries(
		bootstraps.map((bootstrap) => [pairingKey(bootstrap.sessionId), bootstrap]),
	);
}

function bootWithStored(
	bootstraps: SessionBootstrap[],
	options: { local?: LocalArea; relayHandlers?: Record<string, unknown> } = {},
) {
	const local = options.local ?? makeLocalArea(storedPairings(...bootstraps));
	const harness = makeBrowserApi(local);
	const sockets: FakeSocket[] = [];
	const openSocket = mock((_url: string) => {
		const socket = makeFakeSocket();
		sockets.push(socket);
		return socket;
	});
	registerDaemonLink({
		browserApi: harness.api,
		openSocket,
		relayHandlers: options.relayHandlers as never,
	});
	const ask = (payload: Record<string, unknown>) =>
		new Promise<Record<string, unknown> | undefined>((resolve) => {
			const kept = harness.getOnMessage()?.(
				payload,
				extensionPageSender(harness.api),
				(reply) => resolve(reply as Record<string, unknown>),
			);
			if (!kept) resolve(undefined);
		});
	const sentTypes = (socket: FakeSocket | undefined) =>
		(socket?.send.mock.calls ?? []).map(
			([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
		);
	return { ...harness, local, sockets, openSocket, ask, sentTypes };
}

function sessionIdsOf(reply: Record<string, unknown> | undefined): string[] {
	const sessions = (reply?.sessions ?? []) as { sessionId: string }[];
	return sessions.map((session) => session.sessionId).sort();
}

function captureTimeouts() {
	const scheduled: Array<() => void> = [];
	const real = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		if (ms === undefined || ms < 5000) scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	return {
		scheduled,
		restore() {
			globalThis.setTimeout = real;
		},
	};
}

const FIRST = makeBootstrap({ sessionId: "sess-first", token: "tok-first-secret-value" });
const SECOND = makeBootstrap({ sessionId: "sess-second", token: "tok-second-secret-value" });

test("registerDaemonLink connects every stored pairing and sends one connect handshake per pairing when the socket opens", async () => {
	const { sockets, openSocket, sentTypes } = bootWithStored([FIRST, SECOND]);
	await settle();

	expect(openSocket).toHaveBeenCalledTimes(1);
	sockets[0]?.dispatch("open");
	await settle();

	const connects = sentTypes(sockets[0]).filter((frame) => frame.type === "connect");
	expect(
		connects.map((frame) => [frame.sessionId, frame.token]).sort(),
	).toEqual(
		[
			[FIRST.sessionId, FIRST.token],
			[SECOND.sessionId, SECOND.token],
		].sort(),
	);
});

test("registerDaemonLink registers exactly one onStartup and one onInstalled listener, synchronously", () => {
	const { api, onStartupAdd, onInstalledAdd } = makeBrowserApi();

	registerDaemonLink({ browserApi: api, openSocket: () => makeFakeSocket() });

	expect(onStartupAdd).toHaveBeenCalledTimes(1);
	expect(onInstalledAdd).toHaveBeenCalledTimes(1);
});

test("a connection request sent before the store read resolves waits and then replies with both stored sessions", async () => {
	const gate = makeGate();
	const local = makeLocalArea(storedPairings(FIRST, SECOND));
	const read = local.get.getMockImplementation?.() ?? (async () => ({ ...local.data }));
	local.get.mockImplementation(async () => {
		await gate.promise;
		return read();
	});
	const { ask } = bootWithStored([], { local });
	const reply = mock((_value: unknown) => undefined);
	const pending = ask({ type: MSG.connectionRequest }).then(reply);
	await settle();

	expect(reply).not.toHaveBeenCalled();
	gate.open();
	await pending;

	expect(sessionIdsOf(reply.mock.calls[0]?.[0] as Record<string, unknown>)).toEqual(
		[FIRST.sessionId, SECOND.sessionId].sort(),
	);
});

test("a stored pairing is listed by the connection request after startup", async () => {
	const { ask } = bootWithStored([FIRST]);
	await settle();

	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([
		FIRST.sessionId,
	]);
});

test("a store read failure is logged without the token and leaves storage untouched", async () => {
	const gate = makeGate();
	const local = makeLocalArea();
	local.get.mockImplementation(async () => {
		await gate.promise;
		return {};
	});
	const lines: string[] = [];
	const spies = (["error", "warn", "log", "info"] as const).map((method) =>
		spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		}),
	);
	try {
		const { getOnMessage } = bootWithStored([], { local });
		await captureMarker(getOnMessage, FIRST);
		gate.fail(new Error(`read failed for ${FIRST.token}`));
		await settle();

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).not.toContain(FIRST.token);
		expect(local.set).not.toHaveBeenCalled();
		expect(local.remove).not.toHaveBeenCalled();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
});

test("a store read failure at startup logs the failure and leaves stored pairings untouched", async () => {
	const local = makeLocalArea();
	local.get.mockImplementation(() => Promise.reject(new Error("read failed")));
	const lines: string[] = [];
	const spies = (["error", "warn", "log", "info"] as const).map((method) =>
		spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		}),
	);
	try {
		bootWithStored([], { local });
		await settle();

		expect(lines.join("\n")).toContain("pairing storage failed");
		expect(local.set).not.toHaveBeenCalled();
		expect(local.remove).not.toHaveBeenCalled();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
});

test("a store read failure at startup does not log a token-shaped secret from the error", async () => {
	const secret = "ghp_abcdef1234567890ABCDEF";
	const local = makeLocalArea();
	local.get.mockImplementation(() =>
		Promise.reject(new Error(`read failed for ${secret}`)),
	);
	const lines: string[] = [];
	const spies = (["error", "warn", "log", "info"] as const).map((method) =>
		spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		}),
	);
	try {
		bootWithStored([], { local });
		await settle();

		expect(lines.join("\n")).toContain("pairing storage failed");
		expect(lines.join("\n")).not.toContain(secret);
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
});

test("a connection request still answers after a store read failure", async () => {
	const local = makeLocalArea();
	local.get.mockImplementation(() => Promise.reject(new Error("read failed")));
	const spies = (["error", "warn", "log", "info"] as const).map((method) =>
		spyOn(console, method).mockImplementation(() => undefined),
	);
	try {
		const { ask } = bootWithStored([], { local });

		const reply = await ask({ type: MSG.connectionRequest });

		expect(reply?.sessions).toEqual([]);
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
});

test("a stored pairing whose port is outside the daemon range never opens a socket", async () => {
	const tampered = makeBootstrap({
		sessionId: "sess-tampered",
		port: CHAT_DEFAULT_PORT + CHAT_PORT_FALLBACK_COUNT + 1,
	});
	const { openSocket, ask } = bootWithStored([tampered]);
	await settle();

	expect(openSocket).not.toHaveBeenCalled();
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([]);
});

test("a pairing left by an older extension under chat_session in the session area is not migrated and does not break startup", async () => {
	const legacy = makeBootstrap({ sessionId: "sess-legacy", token: "tok-legacy-secret-value" });
	const local = makeLocalArea();
	const harness = makeBrowserApi(local);
	const sessionData = { [`chat_session:${legacy.sessionId}`]: legacy };
	const session = harness.api.storage.session as unknown as {
		get: (keys?: unknown) => Promise<Record<string, unknown>>;
	};
	session.get = mock(async (_keys?: unknown) => ({ ...sessionData }));
	const openSocket = mock((_url: string) => makeFakeSocket());
	registerDaemonLink({ browserApi: harness.api, openSocket });
	await settle();
	const reply = await new Promise<Record<string, unknown> | undefined>((resolve) => {
		harness.getOnMessage()?.(
			{ type: MSG.connectionRequest },
			extensionPageSender(harness.api),
			(value) => resolve(value as Record<string, unknown>),
		);
	});

	expect(openSocket).not.toHaveBeenCalled();
	expect(sessionIdsOf(reply)).toEqual([]);
	expect(harness.api.storage.session.set).not.toHaveBeenCalled();
	expect(harness.api.storage.session.remove).not.toHaveBeenCalled();
	expect(local.set).not.toHaveBeenCalled();
	expect(local.remove).not.toHaveBeenCalled();
	expect(local.data).toEqual({});
	expect(Object.keys(sessionData)).toEqual([`chat_session:${legacy.sessionId}`]);
});

test("MSG.sessionDisconnect on a stored pairing whose socket never connected removes the key before replying ok and drops the session", async () => {
	const local = makeLocalArea(storedPairings(FIRST));
	const { ask } = bootWithStored([], { local });
	await settle();
	let keyPresentAtReply: boolean | undefined;
	const reply = await ask({ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId }).then(
		(value) => {
			keyPresentAtReply = pairingKey(FIRST.sessionId) in local.data;
			return value;
		},
	);

	expect(reply).toEqual({ ok: true });
	expect(keyPresentAtReply).toBe(false);
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([]);
});

test("MSG.markerCaptured writes no key until a session-list confirms the session", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, FIRST);
	socket.dispatch("open");
	await settle();

	expect(local.set).not.toHaveBeenCalled();
	expect(local.data).toEqual({});

	socket.dispatch("message", message(buildSessionListFrame(FIRST.sessionId)));
	await settle();

	expect(Object.keys(local.data)).toEqual([pairingKey(FIRST.sessionId)]);
	expect(local.data[pairingKey(FIRST.sessionId)]).toEqual(FIRST);
});

test("a session list that confirms another session does not persist an unconfirmed one", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, FIRST);
	await captureMarker(getOnMessage, SECOND);
	socket.dispatch("open");
	await settle();

	socket.dispatch("message", message(buildSessionListFrame(SECOND.sessionId)));
	await settle();

	expect(Object.keys(local.data)).toEqual([pairingKey(SECOND.sessionId)]);
});

test("a session that never confirms leaves no key, even after the socket drops", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, FIRST);
	socket.dispatch("open");
	await settle();
	socket.dispatch("close");
	await settle();

	expect(local.data).toEqual({});
	expect(local.set).not.toHaveBeenCalled();
});

test("a bad claim answered with invalid-session leaves no key", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, FIRST);
	socket.dispatch("open");
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "error",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			code: "invalid-session",
			message: "invalid session",
		}),
	);
	await settle();

	expect(local.data).toEqual({});
});

test("a pairing is not written twice when a second session list repeats the confirmation", async () => {
	const { api, local, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, FIRST);
	socket.dispatch("open");
	await settle();

	socket.dispatch("message", message(buildSessionListFrame(FIRST.sessionId)));
	socket.dispatch("message", message(buildSessionListFrame(FIRST.sessionId)));
	await settle();

	expect(local.set).toHaveBeenCalledTimes(1);
});

async function confirmedPairing(options: { relayHandlers?: Record<string, unknown>; local?: LocalArea } = {}) {
	const boot = bootWithStored([FIRST], options);
	await settle();
	const socket = boot.sockets[0] as FakeSocket;
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(FIRST.sessionId)));
	await settle();
	return { ...boot, socket };
}

test("MSG.sessionDisconnect replies not ok when the stored key cannot be removed", async () => {
	const local = makeLocalArea(storedPairings(FIRST));
	local.remove = mock(async () => {
		throw new Error("quota");
	});
	const { ask } = bootWithStored([], { local });
	await settle();
	const reply = await ask({ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId });

	expect(reply).toEqual({ ok: false });
});

test("MSG.sessionDisconnect sends session-disconnect, removes the key before replying ok, and drops the session", async () => {
	const removeGate = makeGate();
	const local = makeLocalArea(storedPairings(FIRST));
	const realRemove = local.remove.getMockImplementation?.();
	local.remove.mockImplementation(async (keys) => {
		await removeGate.promise;
		await realRemove?.(keys);
	});
	const { socket, ask } = await confirmedPairing({ local });
	const reply = mock((_value: unknown) => undefined);

	const pending = ask({ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId }).then(reply);
	await settle();
	const sent = socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
	expect(
		sent.some((f) => f.type === "session-disconnect" && f.sessionId === FIRST.sessionId),
	).toBe(true);
	socket.dispatch(
		"message",
		message({
			type: "session-disconnected",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();
	expect(reply).not.toHaveBeenCalled();

	removeGate.open();
	await pending;

	expect(reply).toHaveBeenCalledWith({ ok: true });
	expect(local.data).not.toHaveProperty([pairingKey(FIRST.sessionId)]);
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([]);
});

test("MSG.sessionDisconnect removes the stored key and replies ok while the connection is down", async () => {
	const local = makeLocalArea(storedPairings(FIRST));
	const { ask } = bootWithStored([], { local });
	await settle();

	const reply = await ask({ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId });

	expect(reply).toEqual({ ok: true });
	expect(local.data).not.toHaveProperty([pairingKey(FIRST.sessionId)]);
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([]);
});

test("MSG.connectionRetry rewrites the stored port of a confirmed pairing to the rediscovered daemon port", async () => {
	const relocatedPort = CHAT_DEFAULT_PORT + 2;
	const stored = makeBootstrap({
		sessionId: "sess-moved",
		token: "tok-moved-secret-value",
		port: CHAT_DEFAULT_PORT,
	});
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
		const port = Number(/:(\d+)\/healthz$/.exec(url)?.[1]);
		return port === relocatedPort
			? ({
					ok: true,
					json: async () => ({ daemon: "dg-daemon", instanceId: "inst-moved" }),
				} as unknown as Response)
			: ({ ok: false } as unknown as Response);
	}) as unknown as typeof fetch);
	try {
		const local = makeLocalArea(storedPairings(stored));
		const boot = bootWithStored([], { local });
		await settle();
		const socket = boot.sockets[0] as FakeSocket;
		socket.dispatch("open");
		await settle();
		socket.dispatch("message", message(buildSessionListFrame(stored.sessionId)));
		await settle();

		const reply = await boot.ask({ type: MSG.connectionRetry });
		await settle();

		expect(reply?.ok).toBe(true);
		expect(local.data[pairingKey(stored.sessionId)]).toEqual({ ...stored, port: relocatedPort });
	} finally {
		fetchSpy.mockRestore();
	}
});

test("MSG.sessionDisconnect aborts that session's pending relay requests", async () => {
	let seen: AbortSignal | undefined;
	const pwExtRun = mock(
		({ signal }: { signal: AbortSignal }) =>
			new Promise<{ ok: false; error: string }>((resolve) => {
				seen = signal;
				signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }));
			}),
	);
	const { socket, ask } = await confirmedPairing({ relayHandlers: { "pw-ext": pwExtRun } });
	socket.dispatch(
		"message",
		message({
			type: "pw-ext-browser-request",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "pw-unpair",
			request: { verb: "current" },
			timeoutMs: 60_000,
		}),
	);
	await settle();
	expect(seen?.aborted).toBe(false);

	const pending = ask({ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId });
	await settle();
	socket.dispatch(
		"message",
		message({
			type: "session-disconnected",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await pending;

	expect(seen?.aborted).toBe(true);
});

test("MSG.sessionDisconnect from a sender that is not an extension page unpairs nothing", async () => {
	const { socket, local, getOnMessage } = await confirmedPairing();
	const reply = mock((_value: unknown) => undefined);

	getOnMessage()?.(
		{ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId },
		{ url: "https://example.com/" },
		reply,
	);
	await settle();

	expect(local.data).toHaveProperty([pairingKey(FIRST.sessionId)]);
	expect(
		socket.send.mock.calls.some(
			([raw]) => JSON.parse(raw as string).type === "session-disconnect",
		),
	).toBe(false);
});

test("an Unpair followed by a late adopt of the same session leaves no key", async () => {
	const setGate = makeGate();
	const { api, local, getOnMessage } = makeBrowserApi();
	const realSet = local.set.getMockImplementation?.();
	local.set.mockImplementation(async (items) => {
		await setGate.promise;
		await realSet?.(items);
	});
	const socket = makeFakeSocket();
	registerDaemonLink({ browserApi: api, openSocket: () => socket });
	await captureMarker(getOnMessage, FIRST);
	socket.dispatch("open");
	await settle();
	socket.dispatch("message", message(buildSessionListFrame(FIRST.sessionId)));
	await settle();
	const reply = new Promise<unknown>((resolve) => {
		getOnMessage()?.(
			{ type: MSG.sessionDisconnect, sessionId: FIRST.sessionId },
			extensionPageSender(api),
			resolve,
		);
	});
	await settle();
	socket.dispatch(
		"message",
		message({
			type: "session-disconnected",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();

	setGate.open();
	await reply;
	await settle();

	expect(local.data).not.toHaveProperty([pairingKey(FIRST.sessionId)]);
});

test("an invalid-session error for a stored pairing removes its key, keeps the other pairing and schedules no retry", async () => {
	const { sockets, local, ask } = bootWithStored([FIRST]);
	await settle();
	const socket = sockets[0] as FakeSocket;
	socket.dispatch("open");
	await settle();
	const timers = captureTimeouts();
	try {
		socket.dispatch(
			"message",
			message({
				type: "error",
				sessionId: FIRST.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				code: "invalid-session",
				message: "invalid session",
			}),
		);
		await flushMicrotasks();
		socket.dispatch("close");
		await flushMicrotasks();

		expect(timers.scheduled).toHaveLength(0);
	} finally {
		timers.restore();
	}
	expect(sockets).toHaveLength(1);
	expect(local.data).not.toHaveProperty([pairingKey(FIRST.sessionId)]);
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([]);
});

test("an invalid-session error for one stored pairing leaves the other pairing stored and connected", async () => {
	const { sockets, local, ask } = bootWithStored([FIRST, SECOND]);
	await settle();
	const socket = sockets[0] as FakeSocket;
	socket.dispatch("open");
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "error",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			code: "invalid-session",
			message: "invalid session",
		}),
	);
	await settle();

	expect(Object.keys(local.data)).toEqual([pairingKey(SECOND.sessionId)]);
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([SECOND.sessionId]);
});

test("a session-closed frame removes the stored key of a pairing that never confirmed", async () => {
	const { sockets, local } = bootWithStored([FIRST]);
	await settle();
	const socket = sockets[0] as FakeSocket;
	socket.dispatch("open");
	await settle();

	socket.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: FIRST.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();

	expect(local.data).not.toHaveProperty([pairingKey(FIRST.sessionId)]);
});

test("a protocol version mismatch drop keeps the stored key, forgets the session in memory and schedules no retry", async () => {
	const { sockets, local, ask } = bootWithStored([FIRST]);
	await settle();
	const socket = sockets[0] as FakeSocket;
	socket.dispatch("open");
	await settle();
	const timers = captureTimeouts();
	try {
		socket.dispatch(
			"message",
			message({
				type: "error",
				sessionId: FIRST.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				message: "protocol version mismatch: expected 9",
			}),
		);
		await flushMicrotasks();
		socket.dispatch("close");
		await flushMicrotasks();

		expect(timers.scheduled).toHaveLength(0);
	} finally {
		timers.restore();
	}
	expect(local.data[pairingKey(FIRST.sessionId)]).toEqual(FIRST);
	expect(local.remove).not.toHaveBeenCalled();
	expect(sessionIdsOf(await ask({ type: MSG.connectionRequest }))).toEqual([]);
});

test("a daemon that is down at browser start is not a drop: no key is removed and the connect retries", async () => {
	const { sockets, local } = bootWithStored([FIRST, SECOND]);
	await settle();
	const timers = captureTimeouts();
	try {
		sockets[0]?.dispatch("close");
		await flushMicrotasks();

		expect(timers.scheduled.length).toBeGreaterThan(0);
	} finally {
		timers.restore();
	}
	expect(local.remove).not.toHaveBeenCalled();
	expect(Object.keys(local.data).sort()).toEqual(
		[pairingKey(FIRST.sessionId), pairingKey(SECOND.sessionId)].sort(),
	);
});

test("the connection request reply and the connection broadcast carry no token", async () => {
	const { sockets, ask, sendMessage } = bootWithStored([FIRST, SECOND]);
	await settle();
	sockets[0]?.dispatch("open");
	await settle();
	sockets[0]?.dispatch("message", message(buildSessionListFrame(FIRST.sessionId)));
	await settle();

	const reply = await ask({ type: MSG.connectionRequest });
	const broadcasts = sendMessage.mock.calls
		.map(([sent]) => sent as { type?: string })
		.filter((sent) => sent.type === MSG.connection);

	expect(sessionIdsOf(reply)).toHaveLength(2);
	expect(broadcasts.length).toBeGreaterThan(0);
	for (const payload of [reply, ...broadcasts]) {
		const text = JSON.stringify(payload);
		expect(text).not.toContain("token");
		expect(text).not.toContain(FIRST.token);
		expect(text).not.toContain(SECOND.token);
	}
});

const MASKED = makeBootstrap({ sessionId: "sess-masked", token: "tok-masked-on-load-only" });

test("a stored token is masked in an error reply after it was loaded at startup", async () => {
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async (input: RequestInfo | URL) =>
			String(input).includes("/healthz")
				? Response.json({ daemon: "dg-daemon", instanceId: "test" })
				: new Response(`nope ${MASKED.token}`, { status: 404 })) as unknown as typeof fetch,
	);
	try {
		clearNotedSecrets();
		const { ask } = bootWithStored([MASKED]);
		await settle();

		const reply = await ask({ type: MSG.sessionAttach, all: true, code: "123456" });

		expect(String(reply?.error)).not.toContain(MASKED.token);
		expect(String(reply?.error)).toContain("[redacted]");
	} finally {
		fetchSpy.mockRestore();
	}
});

describe("pairing storage source contract", () => {
	const lib = new URL("../lib/", import.meta.url);
	const read = (path: string) => readFileSync(new URL(path, lib), "utf8");

	function sourceFiles(dir: URL): URL[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? sourceFiles(new URL(`${entry.name}/`, dir))
				: [new URL(entry.name, dir)],
		);
	}

	test.each([
		"background/daemon-link.ts",
		"background/pairing-store.ts",
	])("%s does not touch storage.session", (path) => {
		expect(read(path)).not.toMatch(/storage\.session/);
	});

	test("only pairing-store.ts spells the pairing key prefix", () => {
		const holders = sourceFiles(lib)
			.filter((file) => /pairing:/.test(readFileSync(file, "utf8")))
			.map((file) => file.pathname.split("/").pop());

		expect(holders).toEqual(["pairing-store.ts"]);
	});

	test("the pairing store reads and writes extension local storage", () => {
		expect(read("background/pairing-store.ts")).toMatch(/storage\.local/);
	});
});
