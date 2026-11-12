import { afterEach } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { exchangeReply, pageFragment } from "./page-code";

export { pageFragment };
import { Window } from "happy-dom";

type Listener = (event?: unknown) => void;

export type FakeSocketHandle = {
	fire(type: string): void;
	receive(payload: Record<string, unknown>): void;
};

export type FetchCall = { url: string; init: RequestInit | undefined };

export type Net = {
	win: Window;
	sockets: { url: string; sent: string[]; handle: FakeSocketHandle }[];
	timeouts: { callback: () => void; ms: number }[];
	fetches: FetchCall[];
};

export type Respond = (call: FetchCall) => Promise<Response>;

const GLOBAL_KEYS = [
	"window",
	"document",
	"WebSocket",
	"fetch",
	"setTimeout",
	"HTMLElement",
	"Node",
	"Element",
	"navigator",
	"location",
	"localStorage",
	"sessionStorage",
] as const;

const realSetTimeout = globalThis.setTimeout;
let saved: Partial<Record<(typeof GLOBAL_KEYS)[number], unknown>> = {};
let openWindow: Window | undefined;
let imports = 0;

export function installPage(
	href: string,
	options: { respond?: Respond; sessionStorage?: Record<string, string> } = {},
): Net {
	const respond =
		options.respond ??
		(() => Promise.reject(new TypeError("Failed to fetch")));
	if (openWindow) {
		restoreGlobals();
		void openWindow.happyDOM.close();
	}
	const win = new Window({ url: href });
	openWindow = win;
	for (const [key, value] of Object.entries(options.sessionStorage ?? {})) {
		win.sessionStorage.setItem(key, value);
	}
	const app = win.document.createElement("div");
	app.id = "app";
	win.document.body.append(app);
	const net: Net = { win, sockets: [], timeouts: [], fetches: [] };
	class FakeSocket {
		static readonly OPEN = 1;
		readyState = 0;
		private listeners = new Map<string, Listener[]>();
		private sentRef: string[] = [];
		constructor(url: string) {
			const entry = {
				url,
				sent: [] as string[],
				handle: {
					fire: (type: string) => {
						if (type === "open") this.readyState = 1;
						if (type === "close") this.readyState = 3;
						for (const listener of this.listeners.get(type) ?? [])
							listener({ type });
					},
					receive: (payload: Record<string, unknown>) => {
						const data = JSON.stringify({
							protocolVersion: CHAT_PROTOCOL_VERSION,
							...payload,
						});
						for (const listener of this.listeners.get("message") ?? [])
							listener({ type: "message", data });
					},
				},
			};
			net.sockets.push(entry);
			this.sentRef = entry.sent;
		}
		addEventListener(type: string, listener: Listener) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		removeEventListener() {}
		send(data: string) {
			this.sentRef.push(data);
		}
		close() {}
	}
	const overrides: Record<string, unknown> = {
		window: win,
		document: win.document,
		HTMLElement: win.HTMLElement,
		Node: win.Node,
		Element: win.Element,
		navigator: win.navigator,
		location: win.location,
		localStorage: win.localStorage,
		sessionStorage: win.sessionStorage,
		WebSocket: FakeSocket,
		fetch: (input: unknown, init?: RequestInit) => {
			const exchanged = exchangeReply(String(input), init);
			if (exchanged) return Promise.resolve(exchanged);
			const call = { url: String(input), init };
			net.fetches.push(call);
			return respond(call);
		},
		setTimeout: (callback: () => void, ms = 0) => {
			net.timeouts.push({ callback, ms });
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

function restoreGlobals(): void {
	const target = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		if (key in saved) target[key] = saved[key];
		else delete target[key];
	}
	saved = {};
}

afterEach(async () => {
	if (!openWindow) return;
	restoreGlobals();
	await openWindow.happyDOM.close();
	openWindow = undefined;
});

export async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await new Promise((r) => realSetTimeout(r, 10));
}

export async function bootChat(net: Net): Promise<void> {
	imports += 1;
	await import(`../../src/chat/page?harness=${imports}`);
	await settle();
	for (const entry of net.timeouts.filter((t) => t.ms === 0)) entry.callback();
	net.timeouts = net.timeouts.filter((t) => t.ms !== 0);
	await settle();
}
