import {
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
	validateSessionBootstrap,
} from "@dg/common";
import { browser } from "wxt/browser";
import { maybeStartRecording as defaultMaybeStartRecording } from "@/lib/background/recording";
import { CHAT_SESSION_KEY_PREFIX, MSG } from "@/lib/chat-messages";
import {
	type ChatClient,
	type ChatClientSocket,
	createChatClient,
	defaultOpenSocket,
} from "@/lib/features/chat-client";

/**
 * The chat page's URL path. Named once here rather than inlined — slice 6 owns
 * `entrypoints/chat/index.html` and must ship at this exact path.
 */
export const CHAT_PAGE_PATH = "chat.html";

/**
 * storage.session key prefix for a captured bootstrap — named once because
 * slice 6's chat page reads these entries and must derive the identical prefix.
 */
export { CHAT_SESSION_KEY_PREFIX } from "@/lib/chat-messages";

function chatSessionKey(sessionId: string): string {
	return `${CHAT_SESSION_KEY_PREFIX}${sessionId}`;
}

// "at most every 20s" per plan.md Slice 4 — keeps the service-worker-owned
// socket receiving without waking the worker more often than needed.
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

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
		sendMessage(message: unknown): Promise<unknown>;
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
	openSocket?: (url: string) => ChatClientSocket;
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

/**
 * True only for a sender belonging to one of THIS extension's own pages — a
 * content script's sender.url is the hosting web page's URL, never a
 * chrome-extension:// one. MSG.clientConnect mints a live session capability
 * from whatever bootstrap it's handed, so it must not trust an arbitrary tab.
 */
function isExtensionPageSender(sender: unknown, api: ChatBrowserApi): boolean {
	if (typeof sender !== "object" || sender === null) return false;
	const url = (sender as { url?: unknown }).url;
	return typeof url === "string" && url.startsWith(api.runtime.getURL(""));
}

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

/** MV3 builds expose `action`; Firefox's MV2 build exposes `browserAction` instead. */
function resolveActionApi(api: ChatBrowserApi): ChatActionApi {
	const action = api.action ?? api.browserAction;
	if (!action) throw new Error("no action or browserAction API available");
	return action;
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
 * Central toolbar-click router, the marker-capture relay, and the ONE
 * background-owned chat socket — ownership, reconnection, rediscovery and
 * demux all delegate to createChatClient (plan.md: "exactly ONE socket
 * implementation").
 */
export function registerChat(options: RegisterChatOptions = {}): ChatClient {
	const api = options.browserApi ?? (browser as unknown as ChatBrowserApi);
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const keepaliveIntervalMs =
		options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
	const maybeStartRecording =
		options.maybeStartRecording ?? defaultMaybeStartRecording;

	const bootstrapsBySession = new Map<string, SessionBootstrap>();
	// Sessions the daemon has ack'd on this socket (a session-list frame follows
	// its accepted connect) — an earlier keepalive would fail capability checks.
	const keepaliveEligible = new Set<string>();
	let currentSocket: ChatClientSocket | undefined;
	let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

	function stopKeepalive(): void {
		if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
		keepaliveTimer = undefined;
		keepaliveEligible.clear();
	}

	function sendKeepalives(): void {
		if (!currentSocket) return;
		for (const sessionId of keepaliveEligible) {
			const bootstrap = bootstrapsBySession.get(sessionId);
			if (bootstrap) currentSocket.send(keepaliveFrame(bootstrap));
		}
	}

	function openSocketWithKeepaliveTeardown(url: string): ChatClientSocket {
		const socket = openSocket(url);
		currentSocket = socket;
		const cleanup = () => {
			if (currentSocket === socket) currentSocket = undefined;
			stopKeepalive();
		};
		socket.addEventListener("close", cleanup);
		socket.addEventListener("error", cleanup);
		return socket;
	}

	const client = createChatClient({
		openSocket: openSocketWithKeepaliveTeardown,
	});

	client.onFrame((frame) => {
		void api.runtime.sendMessage({ type: MSG.frame, frame }).catch(() => {});
		if (frame.type === "session-closed") {
			// Its token is invalidated, and one shared socket means a further
			// keepalive would burn the failed-frame budget for every session on it.
			bootstrapsBySession.delete(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			if (keepaliveEligible.size === 0) stopKeepalive();
			return;
		}
		if (frame.type === "session-pending") {
			// A session the page's create-chat affordance spawned — without this
			// it never enters bootstrapsBySession and so never draws a keepalive.
			const requester = bootstrapsBySession.get(frame.sessionId);
			if (requester) {
				bootstrapsBySession.set(frame.newSession.sessionId, {
					...requester,
					sessionId: frame.newSession.sessionId,
					token: frame.newSession.token,
				});
			}
			return;
		}
		if (frame.type !== "session-list") return;
		const sessionId = frame.sessionId;
		const bootstrap = bootstrapsBySession.get(sessionId);
		if (!bootstrap || keepaliveEligible.has(sessionId)) return;
		keepaliveEligible.add(sessionId);
		currentSocket?.send(keepaliveFrame(bootstrap));
		if (keepaliveTimer === undefined) {
			keepaliveTimer = setInterval(sendKeepalives, keepaliveIntervalMs);
		}
	});

	// Pending-recording start wins; otherwise open chat. Settings stays reachable
	// separately, and this is the ONLY action.onClicked listener registered.
	resolveActionApi(api).onClicked.addListener((tab) => {
		void (async () => {
			if (await maybeStartRecording(tab)) return;
			await api.tabs.create({ url: api.runtime.getURL(CHAT_PAGE_PATH) });
		})();
	});

	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (isMarkerCapturedMessage(message)) {
			const bootstrap = asSessionBootstrap(message.bootstrap);
			if (!bootstrap) return undefined;
			void (async () => {
				await api.storage.session.set({
					[chatSessionKey(bootstrap.sessionId)]: bootstrap,
				});
				await api.tabs.create({ url: api.runtime.getURL(CHAT_PAGE_PATH) });
				bootstrapsBySession.set(bootstrap.sessionId, bootstrap);
				client.connect(bootstrap);
			})();
			return undefined;
		}

		if (typeof message !== "object" || message === null) return undefined;
		const payload = message as Record<string, unknown>;
		try {
			switch (payload.type) {
				case MSG.clientConnect: {
					// Mints a live capability from whatever bootstrap it's handed —
					// only an extension page (the chat tab), never a content script.
					if (!isExtensionPageSender(sender, api)) return undefined;
					const bootstrap = asSessionBootstrap(payload.bootstrap);
					if (!bootstrap) return undefined;
					bootstrapsBySession.set(bootstrap.sessionId, bootstrap);
					client.connect(bootstrap);
					sendResponse({ ok: true, state: client.getConnectionState() });
					return undefined;
				}
				case MSG.userMessage:
					if (
						typeof payload.sessionId !== "string" ||
						typeof payload.body !== "string"
					) {
						return undefined;
					}
					client.sendUserMessage(payload.sessionId, payload.body, {
						...(typeof payload.messageId === "string"
							? { messageId: payload.messageId }
							: {}),
						...(typeof payload.subagentName === "string"
							? { subagentName: payload.subagentName }
							: {}),
					});
					sendResponse({ ok: true });
					return undefined;
				case MSG.sessionCreate:
					if (
						typeof payload.sessionId !== "string" ||
						(payload.role !== "orchestrator" && payload.role !== "agent")
					) {
						return undefined;
					}
					client.requestNewSession(
						payload.sessionId,
						payload.role,
						typeof payload.workset === "string" ? payload.workset : undefined,
					);
					sendResponse({ ok: true });
					return undefined;
				case MSG.sessionClose:
					if (typeof payload.sessionId !== "string") return undefined;
					client.closeSession(payload.sessionId);
					sendResponse({ ok: true });
					return undefined;
				default:
					return undefined;
			}
		} catch (error) {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return undefined;
	});

	return client;
}
