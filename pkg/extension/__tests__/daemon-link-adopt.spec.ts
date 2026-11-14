import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
} from "@dg/common";
import { buildSessionListFrame } from "./utils/frame-fixtures";
import {
	type FakeSocket,
	frameEvent as message,
	installDaemonHealthStub,
	type LocalArea,
	makeBootstrapFactory,
	makeFakeSocket,
	makeLocalArea,
	makeStorage,
	settle,
	TEST_DAEMON_ID,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerDaemonLink } = await import("@/lib/background");
const { MSG } = await import("@dg/pages/chat-messages");

const OTHER_DAEMON_ID = "daemon-other";
const DAEMON_ID_KEY = "daemon:id";

const makeBootstrap = makeBootstrapFactory({
	port: CHAT_DEFAULT_PORT,
	sessionId: "sess-pushed",
	token: "tok-pushed-secret",
	agentIdentity: "claude-orchestrator",
});
const PUSHED = makeBootstrap();
const dismissedKey = (sessionId: string) => `dismissed:${sessionId}`;

beforeEach(() => {
	installDaemonHealthStub();
});

afterEach(() => {
	mock.restore();
});

type Listener = (
	msg: unknown,
	sender: unknown,
	sendResponse: (r: unknown) => void,
) => boolean | undefined;

function bootLink(local: LocalArea = makeLocalArea()) {
	let onMessage: Listener | undefined;
	const sockets: FakeSocket[] = [];
	const urls: string[] = [];
	const api = {
		runtime: {
			onMessage: {
				addListener: mock((cb: Listener) => {
					onMessage = cb;
				}),
			},
			getURL: mock((path: string) => `chrome-extension://test-ext/${path}`),
			sendMessage: mock((_message: unknown) => Promise.resolve(undefined)),
		},
		tabGroups: { onUpdated: { addListener: () => undefined, removeListener: () => undefined } },
		tabs: { create: mock(() => Promise.resolve()), onUpdated: { addListener: () => undefined, removeListener: () => undefined }, onRemoved: { addListener: () => undefined, removeListener: () => undefined } },
		storage: makeStorage(local),
	};
	registerDaemonLink({
		browserApi: api as never,
		openSocket: (url) => {
			urls.push(url);
			const socket = makeFakeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	const ask = (payload: Record<string, unknown>, sender: object = { url: api.runtime.getURL("popup.html") }) =>
		new Promise<unknown>((resolve) => {
			const kept = onMessage?.(payload, sender, resolve);
			if (!kept) resolve(undefined);
		});
	const sent = (socket: FakeSocket | undefined) =>
		(socket?.send.mock.calls ?? []).map(
			([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
		);
	return { local, sockets, urls, ask, sent };
}

async function openLink(boot: ReturnType<typeof bootLink>): Promise<FakeSocket> {
	await settle();
	const socket = boot.sockets[0] as FakeSocket;
	socket.dispatch("open");
	await settle();
	return socket;
}

function adoptFrame(bootstrap: SessionBootstrap & { daemonId?: string }) {
	return message({
		type: "session-adopt",
		bootstrap: { daemonId: TEST_DAEMON_ID, ...bootstrap },
	});
}

function healthByPort(identities: Record<number, string | undefined>) {
	return spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
		const port = Number(/:(\d+)\/healthz$/.exec(url)?.[1]);
		const daemonId = identities[port];
		return daemonId === undefined
			? ({ ok: false } as unknown as Response)
			: Response.json({ daemon: "dg-daemon", instanceId: "inst-test", daemonId });
	}) as unknown as typeof fetch);
}

test("with zero pairings the worker opens a socket to the daemon and adopts a pushed session", async () => {
	const boot = bootLink();
	const socket = await openLink(boot);

	socket.dispatch("message", adoptFrame(PUSHED));
	await settle();

	expect(boot.urls[0]).toBe(`ws://127.0.0.1:${CHAT_DEFAULT_PORT}/ws`);
	const connect = boot.sent(socket).find((frame) => frame.type === "connect");
	expect(connect).toMatchObject({ sessionId: PUSHED.sessionId, token: PUSHED.token });
	const status = (await boot.ask({ type: MSG.connectionRequest })) as {
		sessions: { sessionId: string }[];
	};
	expect(status.sessions.map((s) => s.sessionId)).toEqual([PUSHED.sessionId]);
});

test("the first healthz daemonId is stored under daemon:id", async () => {
	const boot = bootLink();
	await openLink(boot);

	expect(boot.local.data[DAEMON_ID_KEY]).toBe(TEST_DAEMON_ID);
});

test("a stored daemon:id is kept when a different daemon answers first", async () => {
	healthByPort({ [CHAT_DEFAULT_PORT]: OTHER_DAEMON_ID });
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();

	expect(boot.local.data[DAEMON_ID_KEY]).toBe(TEST_DAEMON_ID);
});

test("a port whose daemonId differs from daemon:id gets no frames and no tokens", async () => {
	healthByPort({ [CHAT_DEFAULT_PORT]: OTHER_DAEMON_ID });
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();
	const socket = boot.sockets[0] as FakeSocket;
	const close = mock(() => undefined);
	Object.assign(socket, { close });

	socket.dispatch("open");
	await settle();
	socket.dispatch("message", adoptFrame({ ...PUSHED, daemonId: OTHER_DAEMON_ID }));
	await settle();

	expect(close).toHaveBeenCalled();
	expect(socket.send.mock.calls.length).toBe(0);
	expect(Object.keys(boot.local.data)).toEqual([DAEMON_ID_KEY]);
});

test("a session-adopt whose bootstrap daemonId differs from daemon:id is not adopted", async () => {
	const boot = bootLink();
	const socket = await openLink(boot);

	socket.dispatch("message", adoptFrame({ ...PUSHED, daemonId: OTHER_DAEMON_ID }));
	await settle();

	expect(boot.sent(socket).some((frame) => frame.type === "connect")).toBe(false);
});

test("the same pushed session is adopted once when the daemon pushes it twice", async () => {
	const boot = bootLink();
	const socket = await openLink(boot);

	socket.dispatch("message", adoptFrame(PUSHED));
	socket.dispatch("message", adoptFrame(PUSHED));
	await settle();

	expect(boot.sent(socket).filter((frame) => frame.type === "connect").length).toBe(1);
});

async function unpairPushed() {
	const boot = bootLink();
	const socket = await openLink(boot);
	socket.dispatch("message", adoptFrame(PUSHED));
	await settle();
	socket.dispatch("message", message(buildSessionListFrame([], { sessionId: PUSHED.sessionId })));
	await settle();
	const pending = boot.ask({ type: MSG.sessionDisconnect, sessionId: PUSHED.sessionId });
	await settle();
	socket.dispatch(
		"message",
		message({
			type: "session-disconnected",
			sessionId: PUSHED.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await pending;
	return boot;
}

test("unpair writes dismissed:<sessionId>", async () => {
	const boot = await unpairPushed();

	expect(boot.local.data[dismissedKey(PUSHED.sessionId)]).toBe(true);
});

test("a dismissed session is not re-adopted after a worker restart", async () => {
	const first = await unpairPushed();
	const restarted = bootLink(first.local);
	const socket = await openLink(restarted);

	socket.dispatch("message", adoptFrame(PUSHED));
	await settle();

	expect(restarted.sent(socket).some((frame) => frame.type === "connect")).toBe(false);
});

test("a session-list without the dismissed session keeps its dismissed key and stored pairing", async () => {
	const local = makeLocalArea({
		[DAEMON_ID_KEY]: TEST_DAEMON_ID,
		[dismissedKey("sess-gone")]: true,
		[dismissedKey("sess-live")]: true,
	});
	const boot = bootLink(local);
	const socket = await openLink(boot);
	socket.dispatch("message", adoptFrame(PUSHED));
	await settle();
	socket.dispatch(
		"message",
		message(buildSessionListFrame([{ sessionId: PUSHED.sessionId, agentIdentity: PUSHED.agentIdentity }], { sessionId: PUSHED.sessionId })),
	);
	await settle();
	const pairingKey = Object.keys(local.data).find((key) => key.startsWith("pairing:"));

	socket.dispatch(
		"message",
		message(buildSessionListFrame([], { sessionId: PUSHED.sessionId })),
	);
	await settle();

	expect(local.data[dismissedKey("sess-gone")]).toBe(true);
	expect(local.data[dismissedKey("sess-live")]).toBe(true);
	expect(pairingKey).toBeDefined();
	expect(pairingKey as string in local.data).toBe(true);
});

test("a session-closed frame removes the dismissed key", async () => {
	const local = makeLocalArea({
		[DAEMON_ID_KEY]: TEST_DAEMON_ID,
		[dismissedKey(PUSHED.sessionId)]: true,
	});
	const boot = bootLink(local);
	const socket = await openLink(boot);

	socket.dispatch(
		"message",
		message({
			type: "session-closed",
			sessionId: PUSHED.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		}),
	);
	await settle();

	expect(dismissedKey(PUSHED.sessionId) in local.data).toBe(false);
});

test("the connection reply reports daemonChanged when the pinned daemon is gone and another is live", async () => {
	healthByPort({ [CHAT_DEFAULT_PORT + 1]: OTHER_DAEMON_ID });
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();

	const status = (await boot.ask({ type: MSG.connectionRequest })) as { daemonChanged?: boolean };

	expect(status.daemonChanged).toBe(true);
});

test("the connection reply reports no change when the pinned daemon is live", async () => {
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();

	const status = (await boot.ask({ type: MSG.connectionRequest })) as { daemonChanged?: boolean };

	expect(status.daemonChanged).toBe(false);
});

test("Trust this daemon replaces daemon:id and the link reconnects to the live daemon", async () => {
	healthByPort({ [CHAT_DEFAULT_PORT + 1]: OTHER_DAEMON_ID });
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();
	const opened = boot.urls.length;

	const reply = await boot.ask({ type: MSG.trustDaemon });
	await settle();

	expect(reply).toEqual({ ok: true });
	expect(boot.local.data[DAEMON_ID_KEY]).toBe(OTHER_DAEMON_ID);
	expect(boot.urls.length).toBeGreaterThan(opened);
	expect(boot.urls.at(-1)).toBe(`ws://127.0.0.1:${CHAT_DEFAULT_PORT + 1}/ws`);
});

test("Trust this daemon replies with an error when no daemon is live", async () => {
	healthByPort({});
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();

	const reply = (await boot.ask({ type: MSG.trustDaemon })) as { ok: boolean };

	expect(reply.ok).toBe(false);
	expect(boot.local.data[DAEMON_ID_KEY]).toBe(TEST_DAEMON_ID);
});

test("Trust this daemon ignores a sender that is not the popup", async () => {
	healthByPort({ [CHAT_DEFAULT_PORT + 1]: OTHER_DAEMON_ID });
	const boot = bootLink(makeLocalArea({ [DAEMON_ID_KEY]: TEST_DAEMON_ID }));
	await settle();

	const reply = await boot.ask(
		{ type: MSG.trustDaemon },
		{ url: "chrome-extension://test-ext/options.html", tab: { id: 3 } },
	);

	expect(reply).toBeUndefined();
	expect(boot.local.data[DAEMON_ID_KEY]).toBe(TEST_DAEMON_ID);
});
