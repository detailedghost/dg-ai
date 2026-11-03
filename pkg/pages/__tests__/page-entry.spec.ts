import { afterEach, describe, expect, test } from "bun:test";
import { CHAT_MARKER_KEY, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { Window } from "happy-dom";

const BOOTSTRAP = {
	port: 47823,
	sessionId: "session-a",
	token: "tok/a+b=",
	agentIdentity: "claude-js",
};
const GLOBAL_KEYS = [
	"window",
	"document",
	"WebSocket",
	"fetch",
	"setInterval",
	"clearInterval",
	"setTimeout",
	"HTMLElement",
	"Node",
	"Element",
	"navigator",
	"location",
	"localStorage",
	"sessionStorage",
] as const;

type Saved = Partial<Record<(typeof GLOBAL_KEYS)[number], unknown>>;

const realSetTimeout = globalThis.setTimeout;
let saved: Saved = {};
let openWindow: Window | undefined;
let imports = 0;

afterEach(async () => {
	const target = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		if (key in saved) target[key] = saved[key];
		else delete target[key];
	}
	saved = {};
	await openWindow?.happyDOM.close();
	openWindow = undefined;
});

function fragment(value: unknown): string {
	return `${CHAT_MARKER_KEY}=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

type SocketListener = (event: unknown) => void;

type FakeSocketHandle = {
	url: string;
	fire(type: string): void;
	receive(frame: Record<string, unknown>): void;
};

type Net = {
	win: Window;
	fetches: { url: string; init?: RequestInit }[];
	sockets: string[];
	sent: string[];
	socketHandles: FakeSocketHandle[];
	intervals: { callback: () => void; ms: number }[];
	cleared: unknown[];
	timeouts: (() => void)[];
	delays: number[];
	respond: (url: string) => Promise<Response>;
};

const BOARD_JSON = JSON.stringify({
	goLive: null,
	goNoGo: null,
	lanes: [],
	merges: [],
});

const STORED_BOOTSTRAP_KEY = "dg_local_bootstrap";

const LANE_BOARD_JSON = JSON.stringify({
	lanes: [
		{
			chat: "print",
			task: "Follow ups",
			stage: "e2e",
			kind: "chat",
			publisher: "print-agent",
			updatedAt: "2026-10-02T10:28:00.000Z",
		},
	],
	merges: [],
});

function actionPosts(net: Net): number {
	return net.fetches.filter((call) => call.init?.method === "POST").length;
}

function clickApprove(net: Net): void {
	const button = [...net.win.document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === "Approve",
	);
	button?.dispatchEvent(new net.win.Event("click"));
}

function installGlobals(href: string): Net {
	const win = new Window({ url: href });
	openWindow = win;
	const doc = win.document;
	const app = doc.createElement("div");
	app.id = "app";
	doc.body.append(app);
	const net: Net = {
		win,
		fetches: [],
		sockets: [],
		sent: [],
		socketHandles: [],
		intervals: [],
		cleared: [],
		timeouts: [],
		delays: [],
		respond: () => Promise.resolve(new Response(BOARD_JSON)),
	};
	class FakeSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = FakeSocket.CONNECTING;
		private listeners = new Map<string, SocketListener[]>();
		constructor(url: string) {
			net.sockets.push(url);
			net.socketHandles.push({
				url,
				fire: (type) => {
					if (type === "open") this.readyState = FakeSocket.OPEN;
					if (type === "close") this.readyState = FakeSocket.CLOSED;
					for (const listener of this.listeners.get(type) ?? [])
						listener({ type });
				},
				receive: (frame) => {
					const data = JSON.stringify({
						protocolVersion: CHAT_PROTOCOL_VERSION,
						...frame,
					});
					for (const listener of this.listeners.get("message") ?? [])
						listener({ type: "message", data });
				},
			});
		}
		addEventListener(type: string, listener: SocketListener) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		removeEventListener() {}
		send(data: string) {
			net.sent.push(data);
		}
		close() {}
	}
	const overrides: Record<string, unknown> = {
		window: win,
		document: doc,
		HTMLElement: win.HTMLElement,
		Node: win.Node,
		Element: win.Element,
		navigator: win.navigator,
		location: win.location,
		localStorage: win.localStorage,
		sessionStorage: win.sessionStorage,
		WebSocket: FakeSocket,
		fetch: (url: string, init?: RequestInit) => {
			net.fetches.push({ url, init });
			return net.respond(url);
		},
		setInterval: (callback: () => void, ms: number) => {
			net.intervals.push({ callback, ms });
			return net.intervals.length;
		},
		clearInterval: (handle: unknown) => {
			net.cleared.push(handle);
		},
		setTimeout: (callback: () => void, ms = 0) => {
			net.timeouts.push(callback);
			net.delays.push(ms);
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

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++)
		await new Promise((r) => realSetTimeout(r, 10));
}

async function runTimeouts(net: Net): Promise<void> {
	for (const callback of net.timeouts.splice(0)) callback();
	await settle();
}

function railSessionIds(net: Net): string[] {
	return [...net.win.document.querySelectorAll(".chat-rail__row")].map(
		(row) => row.getAttribute("data-session-id") ?? "",
	);
}

function summary(sessionId: string, agentIdentity: string) {
	return { sessionId, agentIdentity, role: "agent" };
}

async function loadEntry(path: string): Promise<void> {
	imports += 1;
	await import(`${path}?entry=${imports}`);
	await settle();
}

describe("board page entry wiring", () => {
	const href = `http://127.0.0.1:${BOOTSTRAP.port}/board#${fragment(BOOTSTRAP)}`;

	test("sends the session token as a Bearer header when it reads the board", async () => {
		const net = installGlobals(href);

		await loadEntry("../src/board/page");

		const read = net.fetches.find((call) => call.url.endsWith("/overwatch"));
		expect(read?.url).toBe(`http://127.0.0.1:${BOOTSTRAP.port}/overwatch`);
		expect(read?.init?.headers).toMatchObject({
			Authorization: `Bearer ${BOOTSTRAP.token}`,
		});
	});

	test("polls the board every 5000 ms and each tick reads the board again", async () => {
		const net = installGlobals(href);
		await loadEntry("../src/board/page");
		const before = net.fetches.length;

		const poll = net.intervals.filter((interval) => interval.ms === 5000);
		expect(poll).toHaveLength(1);
		poll[0]?.callback();
		await settle();

		expect(net.fetches.length).toBeGreaterThan(before);
	});

	test("makes no network call when the page has no session fragment", async () => {
		const net = installGlobals(`http://127.0.0.1:${BOOTSTRAP.port}/board`);

		await loadEntry("../src/board/page");

		expect(net.fetches).toEqual([]);
		expect(net.sockets).toEqual([]);
		expect(net.intervals.filter((interval) => interval.ms === 5000)).toEqual(
			[],
		);
	});

	test("skips a poll tick while the previous board read is still pending", async () => {
		const net = installGlobals(href);
		await loadEntry("../src/board/page");
		net.respond = () => new Promise<Response>(() => {});
		const poll = net.intervals.find((interval) => interval.ms === 5000);
		const before = net.fetches.length;

		poll?.callback();
		await settle();
		poll?.callback();
		await settle();

		expect(net.fetches.length).toBe(before + 1);
	});

	test("on a 403 shows the expired-token state, stops polling and drops the stored bootstrap", async () => {
		const net = installGlobals(href);
		net.respond = () =>
			Promise.resolve(new Response("refused", { status: 403 }));

		await loadEntry("../src/board/page");

		const pollHandle =
			net.intervals.findIndex((interval) => interval.ms === 5000) + 1;
		expect(pollHandle).toBeGreaterThan(0);
		expect(net.cleared).toContain(pollHandle);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
		expect(net.win.document.body.textContent).toContain(
			"Reopen this page from the chat link",
		);
		expect(net.win.document.body.textContent).not.toContain(
			"Daemon unreachable",
		);
	});
});

describe("board page entry wiring after a refused action", () => {
	const href = `http://127.0.0.1:${BOOTSTRAP.port}/board#${fragment(BOOTSTRAP)}`;

	test("drops the stored bootstrap on a 403 from an action and sends the token no more", async () => {
		const net = installGlobals(href);
		net.respond = (url) =>
			Promise.resolve(
				url.endsWith("/overwatch/action")
					? new Response("refused", { status: 403 })
					: new Response(LANE_BOARD_JSON),
			);
		await loadEntry("../src/board/page");

		clickApprove(net);
		await settle();

		expect(actionPosts(net)).toBe(1);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();

		const requests = net.fetches.length;
		clickApprove(net);
		await settle();

		expect(net.fetches.length).toBe(requests);
	});
});

describe("chat page entry wiring", () => {
	test("appends the encoded session token to the websocket URL", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);

		await loadEntry("../src/chat/page");

		expect(net.sockets.length).toBeGreaterThan(0);
		for (const url of net.sockets) {
			expect(
				url.endsWith(`?token=${encodeURIComponent(BOOTSTRAP.token)}`),
			).toBe(true);
		}
	});

	test("keeps the bootstrap in sessionStorage only and strips the fragment from the URL", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);

		await loadEntry("../src/chat/page");

		expect(
			JSON.parse(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY) ?? "{}"),
		).toMatchObject({ token: BOOTSTRAP.token });
		expect(net.win.localStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeNull();
		expect(net.win.location.href).not.toContain(CHAT_MARKER_KEY);
	});

	test("drops the stored bootstrap when the socket closes before it opens and the daemon refuses the token", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		net.respond = () =>
			Promise.resolve(new Response("refused", { status: 403 }));
		await loadEntry("../src/chat/page");

		net.socketHandles[0]?.fire("close");
		await settle();

		expect(net.fetches.at(-1)?.url).toBe(
			`http://127.0.0.1:${BOOTSTRAP.port}/overwatch`,
		);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
	});

	test("keeps the stored bootstrap when the socket closes before it opens and the daemon is unreachable", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		net.respond = () => Promise.reject(new TypeError("Failed to fetch"));
		await loadEntry("../src/chat/page");

		net.socketHandles[0]?.fire("close");
		await settle();

		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeTruthy();
	});

	test("keeps the stored bootstrap when a socket that opened closes later", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		net.respond = () =>
			Promise.resolve(new Response("refused", { status: 403 }));
		await loadEntry("../src/chat/page");

		net.socketHandles[0]?.fire("open");
		await settle();
		expect(net.sent.map((raw) => JSON.parse(raw).type)).toContain("connect");
		net.socketHandles[0]?.fire("close");
		await settle();

		expect(net.fetches.map(({ url }) => url)).not.toContain(
			`http://127.0.0.1:${BOOTSTRAP.port}/overwatch`,
		);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeTruthy();
	});

	test("reconnects with a session it still holds after New chat and the original session closes", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		net.respond = () =>
			Promise.resolve(new Response("refused", { status: 403 }));
		await loadEntry("../src/chat/page");
		const first = net.socketHandles[0];
		first?.fire("open");
		await settle();

		first?.receive({
			type: "session-pending",
			sessionId: BOOTSTRAP.sessionId,
			newSession: { sessionId: "session-b", token: "tok-b" },
		});
		first?.receive({ type: "session-closed", sessionId: BOOTSTRAP.sessionId });
		first?.fire("close");
		await settle();
		await runTimeouts(net);

		const second = net.socketHandles[1];
		expect(second?.url).toEndWith(`?token=${encodeURIComponent("tok-b")}`);
		expect(
			JSON.parse(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY) ?? "{}"),
		).toMatchObject({
			port: BOOTSTRAP.port,
			sessionId: "session-b",
			token: "tok-b",
		});

		second?.fire("close");
		await settle();

		const probe = net.fetches.at(-1);
		expect(probe?.url).toBe(`http://127.0.0.1:${BOOTSTRAP.port}/overwatch`);
		expect(probe?.init?.headers).toMatchObject({
			Authorization: "Bearer tok-b",
		});
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
	});

	test("keeps the surviving New chat session stored when the original session closes", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		await loadEntry("../src/chat/page");
		const socket = net.socketHandles[0];
		socket?.fire("open");
		await settle();

		socket?.receive({
			type: "session-pending",
			sessionId: BOOTSTRAP.sessionId,
			newSession: { sessionId: "session-b", token: "tok-b" },
		});
		socket?.receive({ type: "session-closed", sessionId: BOOTSTRAP.sessionId });
		await settle();

		expect(
			JSON.parse(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY) ?? "{}"),
		).toMatchObject({ sessionId: "session-b", token: "tok-b" });
	});

	test("clears the stored bootstrap when the last held session closes", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		await loadEntry("../src/chat/page");
		const socket = net.socketHandles[0];
		socket?.fire("open");
		await settle();

		socket?.receive({
			type: "session-pending",
			sessionId: BOOTSTRAP.sessionId,
			newSession: { sessionId: "session-b", token: "tok-b" },
		});
		socket?.receive({ type: "session-closed", sessionId: BOOTSTRAP.sessionId });
		socket?.receive({ type: "session-closed", sessionId: "session-b" });
		await settle();

		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
	});

	test("presents no refused token again on a reconnect", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		net.respond = () =>
			Promise.resolve(new Response("refused", { status: 403 }));
		await loadEntry("../src/chat/page");

		net.socketHandles[0]?.fire("close");
		await settle();
		await runTimeouts(net);
		await runTimeouts(net);

		expect(net.sockets.slice(1).join(" ")).not.toContain(
			encodeURIComponent(BOOTSTRAP.token),
		);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
	});

	test("drops the stored bootstrap when the daemon closes the session", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		await loadEntry("../src/chat/page");
		const socket = net.socketHandles[0];
		socket?.fire("open");
		await settle();

		socket?.receive({ type: "session-closed", sessionId: BOOTSTRAP.sessionId });
		await settle();

		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
	});

	test("drops the stored bootstrap and stops presenting the token after an invalid-session error", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		await loadEntry("../src/chat/page");
		const socket = net.socketHandles[0];
		socket?.fire("open");
		await settle();

		socket?.receive({
			type: "error",
			sessionId: BOOTSTRAP.sessionId,
			message: "invalid or closed session capability",
			code: "invalid-session",
		});
		socket?.fire("close");
		await settle();
		await runTimeouts(net);

		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeFalsy();
		expect(net.sockets.slice(1).join(" ")).not.toContain(
			encodeURIComponent(BOOTSTRAP.token),
		);
	});

	test("lists only the sessions this page holds, including one it creates", async () => {
		const net = installGlobals(
			`http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`,
		);
		await loadEntry("../src/chat/page");
		const socket = net.socketHandles[0];
		socket?.fire("open");
		await settle();

		socket?.receive({
			type: "session-list",
			sessionId: BOOTSTRAP.sessionId,
			sessions: [
				summary(BOOTSTRAP.sessionId, BOOTSTRAP.agentIdentity),
				summary("session-other", "another-agent"),
			],
		});
		await settle();
		expect(railSessionIds(net)).toEqual([BOOTSTRAP.sessionId]);

		socket?.receive({
			type: "session-list",
			sessionId: "session-b",
			sessions: [
				summary(BOOTSTRAP.sessionId, BOOTSTRAP.agentIdentity),
				summary("session-other", "another-agent"),
				summary("session-b", BOOTSTRAP.agentIdentity),
			],
		});
		socket?.receive({
			type: "session-pending",
			sessionId: BOOTSTRAP.sessionId,
			newSession: { sessionId: "session-b", token: "tok-b" },
		});
		await settle();

		expect(railSessionIds(net).sort()).toEqual(
			[BOOTSTRAP.sessionId, "session-b"].sort(),
		);
	});

	test("opens no socket and makes no fetch when the page has no session fragment", async () => {
		const net = installGlobals(`http://127.0.0.1:${BOOTSTRAP.port}/chat`);

		await loadEntry("../src/chat/page");

		expect(net.sockets).toEqual([]);
		expect(net.fetches).toEqual([]);
	});
});

describe("page recovery after a daemon restart", () => {
	const boardHref = `http://127.0.0.1:${BOOTSTRAP.port}/board#${fragment(BOOTSTRAP)}`;
	const chatHref = `http://127.0.0.1:${BOOTSTRAP.port}/chat#${fragment(BOOTSTRAP)}`;

	test("board keeps the bootstrap and polling while the daemon is down, then reads with the same token", async () => {
		const net = installGlobals(boardHref);
		await loadEntry("../src/board/page");
		const poll = net.intervals.find((interval) => interval.ms === 5000);
		net.respond = () => Promise.reject(new TypeError("Failed to fetch"));

		poll?.callback();
		await settle();
		await runTimeouts(net);
		net.respond = () =>
			Promise.resolve(new Response("starting", { status: 503 }));
		await runTimeouts(net);

		expect(net.win.document.body.textContent).toContain("Daemon unreachable");
		expect(net.cleared).toEqual([]);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeTruthy();
		expect(net.delays.length).toBeGreaterThan(0);

		net.respond = () => Promise.resolve(new Response(LANE_BOARD_JSON));
		await runTimeouts(net);
		poll?.callback();
		await settle();

		const read = net.fetches.at(-1);
		expect(read?.init?.headers).toMatchObject({
			Authorization: `Bearer ${BOOTSTRAP.token}`,
		});
		expect(net.win.document.body.textContent).not.toContain(
			"Daemon unreachable",
		);
	});

	test("chat retries with growing delays and the same token while the daemon restarts", async () => {
		const net = installGlobals(chatHref);
		net.respond = () => Promise.reject(new TypeError("Failed to fetch"));
		await loadEntry("../src/chat/page");
		net.socketHandles[0]?.fire("open");
		await settle();
		net.socketHandles[0]?.fire("close");
		await settle();

		for (let attempt = 1; attempt <= 3; attempt++) {
			await runTimeouts(net);
			net.socketHandles[attempt]?.fire("close");
			await settle();
		}
		await runTimeouts(net);
		const reopened = net.socketHandles.at(-1);
		reopened?.fire("open");
		await settle();

		expect(net.socketHandles.length).toBeGreaterThanOrEqual(5);
		for (const url of net.sockets) {
			expect(url).toEndWith(`?token=${encodeURIComponent(BOOTSTRAP.token)}`);
		}
		const retryDelays = net.delays.filter((ms) => ms > 0);
		expect(retryDelays.length).toBeGreaterThanOrEqual(3);
		expect(retryDelays.at(-1)).toBeGreaterThan(retryDelays[0] ?? 0);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeTruthy();
		const connects = net.sent
			.map((raw) => JSON.parse(raw))
			.filter((frame) => frame.type === "connect");
		expect(connects.at(-1)).toMatchObject({
			sessionId: BOOTSTRAP.sessionId,
			token: BOOTSTRAP.token,
		});
	});
});
