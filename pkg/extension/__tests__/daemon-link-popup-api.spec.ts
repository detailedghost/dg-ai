import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { CHAT_DEFAULT_PORT, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { MSG } from "@dg/pages/chat-messages";
import { readChatCode } from "@dg/pages/chat-marker";
import { buildSessionListFrame } from "./utils/frame-fixtures";
import { agentRecordKey, createLock } from "./utils/fake-browser";
import {
	type Listener,
	frameEvent,
	makeBootstrap,
	makeFakeSocket,
	makeLocalArea,
	makeStorage,
	settle,
	TEST_DAEMON_ID,
	TEST_PAGE_CODE,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerDaemonLink } = await import("@/lib/background/daemon-link");

const EXTENSION_ROOT = "chrome-extension://test-ext/";
const POPUP_URL = `${EXTENSION_ROOT}popup.html`;
const RUN_REQUEST_ID = "pw-run-1";

beforeAll(() => {
	if (!("locks" in navigator)) {
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: createLock(),
		});
	}
});

let daemonUp = true;
let codeRefused = false;

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
	input: unknown,
) => {
	const url = String(input);
	if (/\/chat\/code$/.test(url)) {
		return codeRefused
			? new Response("refused", { status: 403 })
			: Response.json({ code: TEST_PAGE_CODE });
	}
	const port = Number(/:(\d+)\/healthz$/.exec(url)?.[1]);
	if (daemonUp && [CHAT_DEFAULT_PORT, CHAT_DEFAULT_PORT + 1].includes(port)) {
		return Response.json({
			daemon: "dg-daemon",
			instanceId: "inst-1",
			daemonId: TEST_DAEMON_ID,
		});
	}
	return new Response("down", { status: 503 });
}) as unknown as typeof fetch);

afterEach(() => {
	daemonUp = true;
	codeRefused = false;
	fetchSpy.mockClear();
});

type TabRow = { id?: number; windowId?: number; url?: string };

function boot(
	options: {
		tabs?: TabRow[];
		relayHandlers?: Record<string, unknown>;
	} = {},
) {
	let onMessage: Listener | undefined;
	const local = makeLocalArea();
	const storage = makeStorage(local);
	const socket = makeFakeSocket();
	const calls: string[] = [];
	const tabsCreate = mock((_props: { url: string }) => Promise.resolve());
	const tabsUpdate = mock((_id: number, _props: Record<string, unknown>) => {
		calls.push("update");
		return Promise.resolve();
	});
	const tabsReload = mock((_id: number) => {
		calls.push("reload");
		return Promise.resolve();
	});
	const tabsQuery = mock((_info: Record<string, unknown>) =>
		Promise.resolve(options.tabs ?? []),
	);
	const windowsUpdate = mock((_id: number, _props: Record<string, unknown>) =>
		Promise.resolve(),
	);
	const onClicked = mock(() => undefined);
	const sendMessage = mock((_message: unknown) => Promise.resolve(undefined));
	const api = {
		action: { onClicked: { addListener: onClicked } },
		runtime: {
			onMessage: {
				addListener: mock((cb: Listener) => {
					onMessage = cb;
				}),
			},
			getURL: (path: string) => `${EXTENSION_ROOT}${path}`,
			getManifest: () => ({ version: "1.10.0" }),
			sendMessage,
			openOptionsPage: mock(() => Promise.resolve()),
			onStartup: { addListener: mock(() => undefined) },
			onInstalled: { addListener: mock(() => undefined) },
		},
		tabs: {
			create: tabsCreate,
			query: tabsQuery,
			update: tabsUpdate,
			reload: tabsReload,
		},
		windows: { update: windowsUpdate },
		storage,
	};
	const link = registerDaemonLink({
		browserApi: api as never,
		openSocket: () => socket,
		relayHandlers: options.relayHandlers as never,
	});

	function post(sender: unknown, message: unknown): Promise<unknown> {
		return new Promise((resolve) => {
			const kept = onMessage?.(message, sender, resolve);
			if (!kept) resolve(undefined);
		});
	}

	return {
		link: link as unknown as {
			client: { connect: unknown };
			adopt(bootstrap: unknown): Promise<void>;
			pending(sessionId?: string): unknown[];
		},
		api,
		socket,
		local,
		storage,
		calls,
		tabsCreate,
		tabsUpdate,
		tabsReload,
		tabsQuery,
		windowsUpdate,
		onClicked,
		sendMessage,
		fromPopup: (message: unknown) => post({ url: POPUP_URL }, message),
		fromOptions: (message: unknown) =>
			post({ url: `${EXTENSION_ROOT}options.html` }, message),
		fromAnywhere: (sender: unknown, message: unknown) => post(sender, message),
		sentFrames: () =>
			socket.send.mock.calls.map(
				([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
			),
	};
}

type Harness = ReturnType<typeof boot>;

const bootstrap = makeBootstrap({ port: CHAT_DEFAULT_PORT });

async function confirmed(
	harness: Harness,
	presence: string | null = "cli",
): Promise<void> {
	await harness.link.adopt(bootstrap);
	harness.socket.dispatch("open");
	await settle();
	harness.socket.dispatch(
		"message",
		frameEvent(
			buildSessionListFrame([
				{
					sessionId: bootstrap.sessionId,
					agentIdentity: bootstrap.agentIdentity,
					...(presence === null ? {} : { presence }),
				} as never,
			]),
		),
	);
	await settle();
}

function pwRunHandler() {
	return {
		"pw-ext": mock(
			(_input: unknown) => new Promise<never>(() => undefined),
		),
	};
}

async function startRun(harness: Harness): Promise<void> {
	harness.socket.dispatch(
		"message",
		frameEvent({
			type: "pw-ext-browser-request",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: RUN_REQUEST_ID,
			request: { verb: "current" },
			timeoutMs: 60_000,
		}),
	);
	await settle();
}

describe("registerDaemonLink return value", () => {
	test("returns the client, adopt and pending", () => {
		const harness = boot();

		expect(typeof harness.link.client.connect).toBe("function");
		expect(typeof harness.link.adopt).toBe("function");
		expect(harness.link.pending()).toEqual([]);
	});

	test("registers no toolbar click listener", () => {
		const harness = boot();

		expect(harness.onClicked).not.toHaveBeenCalled();
	});
});

describe("registerDaemonLink adopt", () => {
	test("holds the bootstrap, sends connect, and writes the pairing key only after the first session-list", async () => {
		const harness = boot();
		const key = `pairing:${bootstrap.sessionId}`;

		await harness.link.adopt(bootstrap);
		harness.socket.dispatch("open");
		await settle();

		const connect = harness.sentFrames().find((frame) => frame.type === "connect");
		expect(connect).toMatchObject({
			type: "connect",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		expect(harness.local.data).not.toHaveProperty(key);

		harness.socket.dispatch(
			"message",
			frameEvent(
				buildSessionListFrame([
					{
						sessionId: bootstrap.sessionId,
						agentIdentity: bootstrap.agentIdentity,
					},
				]),
			),
		);
		await settle();

		expect(harness.local.data[key]).toMatchObject({
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
	});

	test.each([0, 1.5, 70_000])(
		"rejects a bootstrap with port %p and opens no connection",
		async (port) => {
			const harness = boot();

			await expect(
				harness.link.adopt({ ...bootstrap, port }),
			).rejects.toThrow();
			harness.socket.dispatch("open");
			await settle();

			expect(
				harness.sentFrames().filter((frame) => frame.type === "connect"),
			).toEqual([]);
			expect(harness.local.data).not.toHaveProperty(
				`pairing:${bootstrap.sessionId}`,
			);
		},
	);

	test("an adopted session shows up in the connection reply", async () => {
		const harness = boot();
		await confirmed(harness);

		const reply = (await harness.fromPopup({ type: MSG.connectionRequest })) as {
			sessions: Array<{ sessionId: string; connected: boolean }>;
		};

		expect(reply.sessions.map((s) => s.sessionId)).toEqual([bootstrap.sessionId]);
		expect(reply.sessions[0]?.connected).toBe(true);
	});
});

describe("registerDaemonLink pending runs", () => {
	test("pending(sessionId) lists the in-flight run and filters by session", async () => {
		const harness = boot({ relayHandlers: pwRunHandler() });
		await confirmed(harness);

		await startRun(harness);

		const runs = harness.link.pending(bootstrap.sessionId);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toEqual({
			sessionId: bootstrap.sessionId,
			requestId: RUN_REQUEST_ID,
			feature: "pw-ext",
			startedAt: expect.any(Number),
		});
		expect(harness.link.pending()).toEqual(runs);
		expect(harness.link.pending("some-other-session")).toEqual([]);
	});
});

describe("registerDaemonLink connection reply and broadcast", () => {
	test("each session carries presence and exact runs and never a token", async () => {
		const harness = boot({ relayHandlers: pwRunHandler() });
		await confirmed(harness, "cli");
		await startRun(harness);

		const reply = (await harness.fromPopup({ type: MSG.connectionRequest })) as {
			sessions: Array<Record<string, unknown>>;
		};

		const entry = reply.sessions[0] as Record<string, unknown>;
		expect(entry.presence).toBe("cli");
		expect(entry.runs).toEqual(harness.link.pending(bootstrap.sessionId));
		expect(Object.keys((entry.runs as object[])[0] as object).sort()).toEqual([
			"feature",
			"requestId",
			"sessionId",
			"startedAt",
		]);
		expect(entry).not.toHaveProperty("token");
		expect(JSON.stringify(reply)).not.toContain(bootstrap.token);
	});

	test("presence follows the latest session-list and is absent when the daemon sent none", async () => {
		const harness = boot();
		await confirmed(harness, null);

		const before = (await harness.fromPopup({ type: MSG.connectionRequest })) as {
			sessions: Array<Record<string, unknown>>;
		};
		expect(before.sessions[0]?.presence).toBeUndefined();
		expect(before.sessions[0]?.runs).toEqual([]);

		harness.socket.dispatch(
			"message",
			frameEvent(
				buildSessionListFrame([
					{
						sessionId: bootstrap.sessionId,
						agentIdentity: bootstrap.agentIdentity,
						presence: "idle",
					} as never,
				]),
			),
		);
		await settle();
		const after = (await harness.fromPopup({ type: MSG.connectionRequest })) as {
			sessions: Array<Record<string, unknown>>;
		};

		expect(after.sessions[0]?.presence).toBe("idle");
	});

	test("every connection broadcast carries runs per session and no token", async () => {
		const harness = boot({ relayHandlers: pwRunHandler() });
		await confirmed(harness);
		await startRun(harness);
		harness.socket.dispatch("close");
		await settle();

		const broadcasts = harness.sendMessage.mock.calls
			.map(([message]) => message as Record<string, unknown>)
			.filter((message) => message.type === MSG.connection);
		expect(broadcasts.length).toBeGreaterThan(0);
		for (const broadcast of broadcasts) {
			for (const session of broadcast.sessions as Array<Record<string, unknown>>) {
				expect(Array.isArray(session.runs)).toBe(true);
			}
			expect(JSON.stringify(broadcast)).not.toContain(bootstrap.token);
		}
	});
});

describe("registerDaemonLink openChat", () => {
	test("creates a /chat tab that carries a one-time code and no token", async () => {
		const harness = boot();
		await confirmed(harness);

		const reply = await harness.fromPopup({
			type: MSG.openChat,
			sessionId: bootstrap.sessionId,
		});

		expect(reply).toEqual({ ok: true });
		expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
		const url = (harness.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		expect(new URL(url).pathname).toBe("/chat");
		expect(new URL(url).origin).toBe(`http://127.0.0.1:${CHAT_DEFAULT_PORT}`);
		expect(readChatCode(url)).toBe(TEST_PAGE_CODE);
		expect(url).not.toContain(bootstrap.token);
	});

	test("builds the /chat URL from the stored port once its daemon is verified", async () => {
		const harness = boot();
		const stored = makeBootstrap({ port: CHAT_DEFAULT_PORT + 1 });
		await harness.link.adopt(stored);

		const reply = await harness.fromPopup({
			type: MSG.openChat,
			sessionId: stored.sessionId,
		});

		expect(reply).toEqual({ ok: true });
		const url = (harness.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		expect(new URL(url).origin).toBe(`http://127.0.0.1:${stored.port}`);
	});

	test("uses the port the connected socket rediscovered after a daemon restart", async () => {
		const harness = boot();
		await confirmed(harness);
		const rediscovered = CHAT_DEFAULT_PORT + 2;
		(harness.link.client as { getPort?: () => number | undefined }).getPort =
			() => rediscovered;

		const reply = await harness.fromPopup({
			type: MSG.openChat,
			sessionId: bootstrap.sessionId,
		});

		expect(reply).toEqual({ ok: true });
		const url = (harness.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		expect(new URL(url).origin).toBe(`http://127.0.0.1:${rediscovered}`);
	});

	test("looks for an open /chat tab on the daemon port", async () => {
		const harness = boot();
		await confirmed(harness);

		await harness.fromPopup({ type: MSG.openChat, sessionId: bootstrap.sessionId });

		expect(JSON.stringify(harness.tabsQuery.mock.calls[0])).toContain(
			`http://127.0.0.1:${CHAT_DEFAULT_PORT}/chat*`,
		);
	});

	test("reuses an open /chat tab: update with the new url, then reload, then focus its window", async () => {
		const open = {
			id: 31,
			windowId: 3,
			url: `http://127.0.0.1:${CHAT_DEFAULT_PORT}/chat`,
		};
		const harness = boot({ tabs: [open] });
		await confirmed(harness);

		const reply = await harness.fromPopup({
			type: MSG.openChat,
			sessionId: bootstrap.sessionId,
		});

		expect(reply).toEqual({ ok: true });
		expect(harness.tabsCreate).not.toHaveBeenCalled();
		const expectedUrl = `http://127.0.0.1:${CHAT_DEFAULT_PORT}/chat`;
		const [updatedId, props] = harness.tabsUpdate.mock.calls[0] as [
			number,
			{ url: string; active: boolean },
		];
		expect(updatedId).toBe(31);
		expect(props.active).toBe(true);
		expect(props.url.split("#")[0]).toBe(expectedUrl);
		expect(readChatCode(props.url)).toBe(TEST_PAGE_CODE);
		expect(harness.tabsReload).toHaveBeenCalledWith(31);
		expect(harness.calls).toEqual(["update", "reload"]);
		expect(harness.windowsUpdate).toHaveBeenCalledWith(3, { focused: true });
	});

	test("replies an error and opens nothing when the daemon refuses to issue a page code", async () => {
		const harness = boot();
		await confirmed(harness);
		codeRefused = true;

		const reply = (await harness.fromPopup({
			type: MSG.openChat,
			sessionId: bootstrap.sessionId,
		})) as { ok: boolean; error?: string };

		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("403");
		expect(harness.tabsCreate).not.toHaveBeenCalled();
	});

	test("replies an error and opens nothing when no daemon port is known", async () => {
		const harness = boot();
		await confirmed(harness);
		daemonUp = false;

		const reply = (await harness.fromPopup({
			type: MSG.openChat,
			sessionId: bootstrap.sessionId,
		})) as { ok: boolean; error?: string };

		expect(reply.ok).toBe(false);
		expect(typeof reply.error).toBe("string");
		expect(reply.error?.length).toBeGreaterThan(0);
		expect(harness.tabsCreate).not.toHaveBeenCalled();
		expect(harness.tabsUpdate).not.toHaveBeenCalled();
	});
});

describe("registerDaemonLink popup-only message gate", () => {
	const senders: Array<[string, unknown]> = [
		["a content script tab", { tab: { id: 8 }, url: "https://example.com/" }],
		["an extension url on a tab", { tab: { id: 8 }, url: POPUP_URL }],
		["a web page url", { url: "https://example.com/" }],
		["no url", {}],
	];

	test.each(senders)("openChat from %s is refused and opens nothing", async (_name, sender) => {
		const harness = boot();
		await confirmed(harness);

		const reply = await harness.fromAnywhere(sender, {
			type: MSG.openChat,
			sessionId: bootstrap.sessionId,
		});

		expect(reply).toBeUndefined();
		expect(harness.tabsCreate).not.toHaveBeenCalled();
		expect(harness.tabsUpdate).not.toHaveBeenCalled();
	});

	test.each(senders)("sessionDisconnect from %s is refused and deletes nothing", async (_name, sender) => {
		const harness = boot();
		await confirmed(harness);
		const key = `pairing:${bootstrap.sessionId}`;

		const reply = await harness.fromAnywhere(sender, {
			type: MSG.sessionDisconnect,
			sessionId: bootstrap.sessionId,
		});
		await settle();

		expect(reply).toBeUndefined();
		expect(
			harness.sentFrames().some((frame) => frame.type === "session-disconnect"),
		).toBe(false);
		expect(harness.local.data).toHaveProperty(key);
		expect(harness.storage.session.remove).not.toHaveBeenCalled();
	});
});

describe("registerDaemonLink forgets agent tabs", () => {
	const key = () => agentRecordKey(bootstrap.sessionId);

	function removedKeys(harness: Harness): unknown[] {
		return harness.storage.session.remove.mock.calls.map(([arg]) => arg);
	}

	test("Unpair forgets that session's agent tab record", async () => {
		const harness = boot();
		await confirmed(harness);

		const reply = harness.fromPopup({
			type: MSG.sessionDisconnect,
			sessionId: bootstrap.sessionId,
		});
		await settle();
		harness.socket.dispatch(
			"message",
			frameEvent({
				type: "session-disconnected",
				sessionId: bootstrap.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		await reply;
		await settle();

		expect(removedKeys(harness)).toContain(key());
	});

	test("a session-closed frame forgets it", async () => {
		const harness = boot();
		await confirmed(harness);

		harness.socket.dispatch(
			"message",
			frameEvent({
				type: "session-closed",
				sessionId: bootstrap.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		await settle();

		expect(removedKeys(harness)).toContain(key());
	});

	test("an invalid-session drop forgets it", async () => {
		const harness = boot();
		await confirmed(harness);

		harness.socket.dispatch(
			"message",
			frameEvent({
				type: "error",
				sessionId: bootstrap.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				code: "invalid-session",
				message: "unknown session",
			}),
		);
		await settle();

		expect(removedKeys(harness)).toContain(key());
	});

	test("nothing is forgotten while the session stays paired", async () => {
		const harness = boot();
		await confirmed(harness);

		expect(removedKeys(harness)).not.toContain(key());
	});
});
