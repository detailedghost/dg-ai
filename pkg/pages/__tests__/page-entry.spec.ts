import { afterEach, describe, expect, test } from "bun:test";
import { CHAT_MARKER_KEY } from "@dg/common";
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
};

type Net = {
	win: Window;
	fetches: { url: string; init?: RequestInit }[];
	sockets: string[];
	socketHandles: FakeSocketHandle[];
	intervals: { callback: () => void; ms: number }[];
	cleared: unknown[];
	respond: (url: string) => Promise<Response>;
};

const BOARD_JSON = JSON.stringify({
	goLive: null,
	goNoGo: null,
	lanes: [],
	merges: [],
});

const STORED_BOOTSTRAP_KEY = "dg_local_bootstrap";

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
		socketHandles: [],
		intervals: [],
		cleared: [],
		respond: () => Promise.resolve(new Response(BOARD_JSON)),
	};
	class FakeSocket {
		readyState = 0;
		private listeners = new Map<string, SocketListener[]>();
		constructor(url: string) {
			net.sockets.push(url);
			net.socketHandles.push({
				url,
				fire: (type) => {
					for (const listener of this.listeners.get(type) ?? [])
						listener({ type });
				},
			});
		}
		addEventListener(type: string, listener: SocketListener) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		removeEventListener() {}
		send() {}
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
		setTimeout: () => 0,
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
		net.socketHandles[0]?.fire("close");
		await settle();

		expect(net.fetches.map(({ url }) => url)).not.toContain(
			`http://127.0.0.1:${BOOTSTRAP.port}/overwatch`,
		);
		expect(net.win.sessionStorage.getItem(STORED_BOOTSTRAP_KEY)).toBeTruthy();
	});

	test("opens no socket and makes no fetch when the page has no session fragment", async () => {
		const net = installGlobals(`http://127.0.0.1:${BOOTSTRAP.port}/chat`);

		await loadEntry("../src/chat/page");

		expect(net.sockets).toEqual([]);
		expect(net.fetches).toEqual([]);
	});
});
