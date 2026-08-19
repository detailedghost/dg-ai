/**
 * lib/background/chat.ts's registerChat: toolbar-click router, marker-capture
 * relay (storage.session write + tab open), and the keepalive that keeps a
 * session's WebSocket receiving while its chat tab is closed. Seam names are
 * pinned in plan.md's "Transport and naming ratifications (execute-mode, layer 1)".
 */

import { expect, mock, test } from "bun:test";
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

type FakeSocket = {
	send: ReturnType<typeof mock>;
	addEventListener: ReturnType<typeof mock>;
	dispatch(type: string): void;
};

function makeFakeSocket(): FakeSocket {
	const listeners: Record<string, Array<() => void>> = {};
	return {
		send: mock((_data: string) => undefined),
		addEventListener: mock((type: string, cb: () => void) => {
			if (!listeners[type]) listeners[type] = [];
			listeners[type].push(cb);
		}),
		dispatch(type: string) {
			for (const cb of listeners[type] ?? []) cb();
		},
	};
}

test("sends a keepalive periodically once the socket reports itself open", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	// Short override so the periodic behavior is observable without a real 20s wait.
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const listener = getOnMessage();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
		{},
		mock(() => undefined),
	);
	await settle();
	expect(openSocket).toHaveBeenCalledTimes(1);

	socket.dispatch("open");
	await new Promise((resolve) => setTimeout(resolve, 70));

	expect(socket.send.mock.calls.length).toBeGreaterThanOrEqual(3);
});

test("sends no keepalive before the socket reports itself open", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const listener = getOnMessage();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
		{},
		mock(() => undefined),
	);
	await settle();

	// Deliberately never dispatch "open" — the socket stays pending.
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(socket.send).not.toHaveBeenCalled();
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
		const listener = getOnMessage();
		listener?.(
			{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
			{},
			mock(() => undefined),
		);
		await settle();
		socket.dispatch("open");
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
	const listener = getOnMessage();
	const bootstrap = makeBootstrap();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap },
		{},
		mock(() => undefined),
	);
	await settle();

	socket.dispatch("open");

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
	const listener = getOnMessage();
	const bootstrap = makeBootstrap();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap },
		{},
		mock(() => undefined),
	);
	await settle();

	socket.dispatch("open");
	await new Promise((resolve) => setTimeout(resolve, 25));

	// index 0 is the "connect" handshake (separately asserted above) — every
	// frame after it is a keepalive.
	const keepaliveFrames = socket.send.mock.calls
		.slice(1)
		.map(([raw]) => JSON.parse(raw as string));
	expect(keepaliveFrames.length).toBeGreaterThan(0);
	for (const parsed of keepaliveFrames) {
		// Real production validator from @dg/common — catches wire-format drift
		// between this seam and the daemon's own parser, not a re-implemented shape check.
		expect(() => validateChatFrame(parsed)).not.toThrow();
		// Not "config-get": that discriminant always draws an unimplemented-transport
		// error frame from the daemon every interval — see plan.md's Layer-1 QA corrections.
		expect(parsed).toEqual({
			type: "keepalive",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		});
	}
});

test("sends the first keepalive frame immediately on open (right after the handshake), not after waiting one full interval", async () => {
	// Regression: no inbound frame routes until the handshake lands, and the
	// keepalive must not then wait 20s more before its own first send.
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 10_000 });
	const listener = getOnMessage();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
		{},
		mock(() => undefined),
	);
	await settle();

	socket.dispatch("open");

	// Frame 0 is "connect", frame 1 is the immediate keepalive.
	expect(socket.send).toHaveBeenCalledTimes(2);
});

test("opens the WebSocket at the bootstrap's own port, never a hardcoded one", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket });
	const listener = getOnMessage();
	// Within the daemon's ratified fallback range but not the default port itself.
	const bootstrap = makeBootstrap({ port: CHAT_DEFAULT_PORT + 3 });

	listener?.(
		{ type: MSG.markerCaptured, bootstrap },
		{},
		mock(() => undefined),
	);
	await settle();

	expect(openSocket).toHaveBeenCalledWith(
		`ws://127.0.0.1:${CHAT_DEFAULT_PORT + 3}/ws`,
	);
});

test("keepalive stops once the socket reports itself closed, leaving no dangling timer", async () => {
	const { api, getOnMessage } = makeBrowserApi();
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	registerChat({ browserApi: api, openSocket, keepaliveIntervalMs: 15 });
	const listener = getOnMessage();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
		{},
		mock(() => undefined),
	);
	await settle();

	socket.dispatch("open");
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
	const listener = getOnMessage();
	listener?.(
		{ type: MSG.markerCaptured, bootstrap: makeBootstrap() },
		{},
		mock(() => undefined),
	);
	await settle();

	socket.dispatch("open");
	await new Promise((resolve) => setTimeout(resolve, 50));
	const sentBeforeError = socket.send.mock.calls.length;
	expect(sentBeforeError).toBeGreaterThan(0);

	socket.dispatch("error");
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(socket.send.mock.calls.length).toBe(sentBeforeError);
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
