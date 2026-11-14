import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
} from "@dg/common";
import { readChatCode } from "@dg/pages/chat-marker";
import { buildSessionListFrame } from "./utils/frame-fixtures";
import {
	frameEvent,
	makeBootstrapFactory,
	makeFakeSocket,
	makeLocalArea,
	makeStorage,
	installDaemonHealthStub,
	settle,
	TEST_DAEMON_ID,
	TEST_PAGE_CODE,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

beforeEach(() => {
	installDaemonHealthStub();
});

afterEach(() => {
	mock.restore();
});

const { registerDaemonLink } = await import("@/lib/background/daemon-link");

const makeBootstrap = makeBootstrapFactory({
	port: CHAT_DEFAULT_PORT,
	sessionId: "sess-abc123",
	token: "tok-xyz789",
	agentIdentity: "claude-orchestrator",
});

function boot() {
	const local = makeLocalArea();
	const tabsCreate = mock((_props: { url: string }) => Promise.resolve());
	const sidePanelOpen = mock(() => Promise.resolve());
	const api = {
		action: { onClicked: { addListener: mock(() => undefined) } },
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			getURL: (path: string) => `chrome-extension://test-ext/${path}`,
			getManifest: () => ({ version: "1.9.3" }),
			sendMessage: mock((_m: unknown) => Promise.resolve(undefined)),
			openOptionsPage: mock(() => Promise.resolve()),
			onStartup: { addListener: mock(() => undefined) },
			onInstalled: { addListener: mock(() => undefined) },
		},
		tabGroups: { onUpdated: { addListener: () => undefined, removeListener: () => undefined } },
		tabs: {
			onUpdated: { addListener: () => undefined, removeListener: () => undefined }, onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			create: tabsCreate,
			query: mock(() => Promise.resolve([])),
			update: mock(() => Promise.resolve()),
		},
		windows: { update: mock(() => Promise.resolve()) },
		sidePanel: { open: sidePanelOpen },
		storage: makeStorage(local),
	};
	const socket = makeFakeSocket();
	const openSocket = mock((_url: string) => socket);
	const link = registerDaemonLink({
		browserApi: api as never,
		openSocket,
	});
	return {
		adopt: link.adopt,
		client: link.client,
		api,
		local,
		socket,
		openSocket,
		tabsCreate,
		sidePanelOpen,
	};
}

function sentFrames(socket: ReturnType<typeof makeFakeSocket>) {
	return socket.send.mock.calls.map(
		([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
	);
}

function overwatchOpen(requestId: string) {
	return frameEvent({
		type: "overwatch-open",
		sessionId: OVERWATCH_SESSION_ID,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId,
	});
}

describe("registerDaemonLink adopt without a chat page", () => {
	test("an adopted bootstrap connects to the daemon", async () => {
		const link = boot();
		const bootstrap = makeBootstrap({ port: CHAT_DEFAULT_PORT + 1 });

		await link.adopt(bootstrap);

		expect(link.openSocket).toHaveBeenCalledTimes(1);
		expect(String(link.openSocket.mock.calls[0]?.[0])).toContain(
			`:${bootstrap.port}`,
		);
	});

	test("holds the bootstrap in memory and writes the key only on the first confirming session-list", async () => {
		const link = boot();
		const bootstrap = makeBootstrap();
		await link.adopt(bootstrap);
		link.socket.dispatch("open");
		await settle();
		expect(link.local.data).toEqual({ "daemon:id": TEST_DAEMON_ID });

		link.socket.dispatch(
			"message",
			frameEvent(buildSessionListFrame([], { sessionId: bootstrap.sessionId })),
		);
		await settle();

		expect(link.local.data[`pairing:${bootstrap.sessionId}`]).toEqual({
			...bootstrap,
			daemonId: TEST_DAEMON_ID,
		});
	});

	test("never opens a tab or a side panel", async () => {
		const link = boot();
		const bootstrap = makeBootstrap();
		await link.adopt(bootstrap);
		link.socket.dispatch("open");
		await settle();
		link.socket.dispatch(
			"message",
			frameEvent(buildSessionListFrame([], { sessionId: bootstrap.sessionId })),
		);
		await settle();

		expect(link.tabsCreate).not.toHaveBeenCalled();
		expect(link.sidePanelOpen).not.toHaveBeenCalled();
	});
});

describe("registerDaemonLink overwatch-open", () => {
	async function confirmed() {
		const link = boot();
		const bootstrap = makeBootstrap();
		await link.adopt(bootstrap);
		link.socket.dispatch("open");
		await settle();
		link.socket.dispatch(
			"message",
			frameEvent(buildSessionListFrame([], { sessionId: bootstrap.sessionId })),
		);
		await settle();
		return { link, bootstrap };
	}

	test("asks the live daemon port, not the stored one, for the board code", async () => {
		const { link, bootstrap } = await confirmed();
		const livePort = bootstrap.port + 2;
		(link.client as { getPort?: () => number | undefined }).getPort = () => livePort;

		link.socket.dispatch("message", overwatchOpen("open-live"));
		await settle();

		const url = (link.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		expect(new URL(url).origin).toBe(`http://127.0.0.1:${livePort}`);
		const mintCalls = (
			globalThis.fetch as unknown as { mock: { calls: [string][] } }
		).mock.calls.filter(([target]) => String(target).endsWith("/chat/code"));
		expect(mintCalls.map(([target]) => target)).toEqual([
			`http://127.0.0.1:${livePort}/chat/code`,
		]);
	});

	test("opens /board with a one-time code, not the token, in the fragment and answers ok", async () => {
		const { link, bootstrap } = await confirmed();

		link.socket.dispatch("message", overwatchOpen("open-1"));
		await settle();

		expect(link.tabsCreate).toHaveBeenCalledTimes(1);
		const url = (link.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		expect(new URL(url).origin).toBe(`http://127.0.0.1:${bootstrap.port}`);
		expect(new URL(url).pathname).toBe("/board");
		expect(readChatCode(url)).toBe(TEST_PAGE_CODE);
		expect(url).not.toContain(bootstrap.token);
		expect(
			sentFrames(link.socket).find((f) => f.type === "overwatch-open-result"),
		).toEqual({
			type: "overwatch-open-result",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "open-1",
			ok: true,
		});
	});

	test("stays silent while no session is confirmed", async () => {
		const link = boot();
		const bootstrap = makeBootstrap();
		await link.adopt(bootstrap);
		link.socket.dispatch("open");
		await settle();

		link.socket.dispatch("message", overwatchOpen("open-early"));
		await settle();

		expect(
			sentFrames(link.socket).some((f) => f.type === "overwatch-open-result"),
		).toBe(false);
		expect(link.tabsCreate).not.toHaveBeenCalled();
	});
});
