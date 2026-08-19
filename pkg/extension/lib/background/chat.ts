import {
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
	validateSessionBootstrap,
} from "@dg/common";
import { browser } from "wxt/browser";
import { maybeStartRecording as defaultMaybeStartRecording } from "@/lib/background/recording";
import { MSG } from "@/lib/chat-messages";

/**
 * The chat page's URL path. Named once here rather than inlined — slice 6 owns
 * `entrypoints/chat/index.html` and must ship at this exact path.
 */
export const CHAT_PAGE_PATH = "chat.html";

/**
 * storage.session key prefix for a captured bootstrap — named once because
 * slice 6's chat page reads these entries and must derive the identical prefix.
 */
export const CHAT_SESSION_KEY_PREFIX = "chat_session:";

function chatSessionKey(sessionId: string): string {
	return `${CHAT_SESSION_KEY_PREFIX}${sessionId}`;
}

// "at most every 20s" per plan.md Slice 4 — keeps the service-worker-owned
// socket receiving without waking the worker more often than needed.
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

/** The subset of a WebSocket registerChat needs — real or a test double. */
export type ChatSocket = {
	send(data: string): void;
	addEventListener(
		type: "open" | "close" | "message" | "error",
		listener: (event?: unknown) => void,
	): void;
};

type ChatActionApi = {
	onClicked: {
		addListener(listener: (tab?: chrome.tabs.Tab) => void): void;
	};
};

/** Browser API surface registerChat needs — content scripts lack storage.session and tabs.create. */
export type ChatBrowserApi = {
	// Firefox's manifest is MV2 (`browser_action`), not MV3 `action` — only one of the two exists at runtime.
	action?: ChatActionApi;
	browserAction?: ChatActionApi;
	runtime: {
		onMessage: {
			addListener(
				listener: (
					message: unknown,
					sender: unknown,
					sendResponse: (response: unknown) => void,
				) => boolean | undefined,
			): void;
		};
		getURL(path: string): string;
	};
	tabs: {
		create(props: { url: string }): unknown;
	};
	storage: {
		session: {
			set(items: Record<string, unknown>): Promise<void>;
		};
	};
};

/** Injectable browser seams and timing, mirroring RegisterProtoOptions. */
export type RegisterChatOptions = {
	browserApi?: ChatBrowserApi;
	openSocket?: (url: string) => ChatSocket;
	keepaliveIntervalMs?: number;
	maybeStartRecording?: (tab?: chrome.tabs.Tab) => Promise<boolean>;
};

function isMarkerCapturedMessage(
	message: unknown,
): message is { type: typeof MSG.markerCaptured; bootstrap: unknown } {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as Record<string, unknown>).type === MSG.markerCaptured
	);
}

const CHAT_MAX_PORT = CHAT_DEFAULT_PORT + CHAT_PORT_FALLBACK_COUNT;

/** The relay only ever carries a marker's SessionBootstrap, never a lockfile — validate as such directly. */
function asSessionBootstrap(candidate: unknown): SessionBootstrap | undefined {
	try {
		const bootstrap = validateSessionBootstrap(candidate);
		// Any loopback page can forge a bootstrap — bound the port before opening a socket to it.
		if (bootstrap.port < CHAT_DEFAULT_PORT || bootstrap.port > CHAT_MAX_PORT) {
			return undefined;
		}
		return bootstrap;
	} catch {
		return undefined;
	}
}

function chatSocketUrl(bootstrap: SessionBootstrap): string {
	return `ws://127.0.0.1:${bootstrap.port}/ws`;
}

function defaultOpenSocket(url: string): ChatSocket {
	return new WebSocket(url) as unknown as ChatSocket;
}

/** MV3 builds expose `action`; Firefox's MV2 build exposes `browserAction` instead. */
function resolveActionApi(api: ChatBrowserApi): ChatActionApi {
	const action = api.action ?? api.browserAction;
	if (!action) throw new Error("no action or browserAction API available");
	return action;
}

// "connect" sits outside the 17 ratified ChatFrame discriminants — the daemon's
// capability handshake, required before any other frame can be routed here.
function connectFrame(bootstrap: SessionBootstrap): string {
	return JSON.stringify({
		type: "connect",
		sessionId: bootstrap.sessionId,
		token: bootstrap.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	});
}

function keepaliveFrame(bootstrap: SessionBootstrap): string {
	// Dedicated inbound discriminant: the daemon notes activity and replies with
	// nothing, unlike "config-get" which always draws an unimplemented-transport error.
	return JSON.stringify({
		type: "keepalive",
		sessionId: bootstrap.sessionId,
		token: bootstrap.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	});
}

/**
 * On open: send the connect handshake first to establish capability, then
 * fire a keepalive frame immediately and every interval after, clearing the
 * timer on close/error so it never outlives the socket.
 */
function startKeepalive(
	socket: ChatSocket,
	bootstrap: SessionBootstrap,
	intervalMs: number,
): void {
	socket.addEventListener("open", () => {
		socket.send(connectFrame(bootstrap));
		socket.send(keepaliveFrame(bootstrap));
		const timer = setInterval(() => {
			socket.send(keepaliveFrame(bootstrap));
		}, intervalMs);
		const stop = () => clearInterval(timer);
		socket.addEventListener("close", stop);
		socket.addEventListener("error", stop);
	});
}

/**
 * Central toolbar-click router, the marker-capture relay (storage.session write
 * plus tab open), and the background-owned socket that keeps a session
 * receiving while its chat tab is closed.
 */
export function registerChat(options: RegisterChatOptions = {}): void {
	const api = options.browserApi ?? (browser as unknown as ChatBrowserApi);
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const keepaliveIntervalMs =
		options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
	const maybeStartRecording =
		options.maybeStartRecording ?? defaultMaybeStartRecording;

	// Pending-recording start wins; otherwise open chat. Settings stays reachable
	// separately, and this is the ONLY action.onClicked listener registered.
	resolveActionApi(api).onClicked.addListener((tab) => {
		void (async () => {
			if (await maybeStartRecording(tab)) return;
			await api.tabs.create({ url: api.runtime.getURL(CHAT_PAGE_PATH) });
		})();
	});

	api.runtime.onMessage.addListener((message) => {
		if (!isMarkerCapturedMessage(message)) return undefined;
		const bootstrap = asSessionBootstrap(message.bootstrap);
		if (!bootstrap) return undefined;
		void (async () => {
			await api.storage.session.set({
				[chatSessionKey(bootstrap.sessionId)]: bootstrap,
			});
			await api.tabs.create({ url: api.runtime.getURL(CHAT_PAGE_PATH) });
			const socket = openSocket(chatSocketUrl(bootstrap));
			startKeepalive(socket, bootstrap, keepaliveIntervalMs);
		})();
		return undefined;
	});
}
