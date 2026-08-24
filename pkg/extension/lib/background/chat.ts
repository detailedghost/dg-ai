import {
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
	validateSessionBootstrap,
} from "@dg/common";
import { browser } from "wxt/browser";
import { maybeStartRecording as defaultMaybeStartRecording } from "@/lib/background/recording";
import {
	CHAT_SESSION_KEY_PREFIX,
	type ConfigRelayReply,
	MSG,
} from "@/lib/chat-messages";
import {
	type ChatClient,
	type ChatClientSocket,
	createChatClient,
	defaultOpenSocket,
} from "@/lib/features/chat-client";

export const CHAT_PAGE_PATH = "chat.html";

export { CHAT_SESSION_KEY_PREFIX } from "@/lib/chat-messages";

function chatSessionKey(sessionId: string): string {
	return `${CHAT_SESSION_KEY_PREFIX}${sessionId}`;
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

type ChatActionApi = {
	onClicked: {
		addListener(listener: (tab?: chrome.tabs.Tab) => void): void;
	};
};

export type ChatBrowserApi = {
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
			remove(keys: string | string[]): Promise<void>;
		};
	};
};

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

function isExtensionPageSender(sender: unknown, api: ChatBrowserApi): boolean {
	if (typeof sender !== "object" || sender === null) return false;
	const url = (sender as { url?: unknown }).url;
	return typeof url === "string" && url.startsWith(api.runtime.getURL(""));
}

function asSessionBootstrap(candidate: unknown): SessionBootstrap | undefined {
	try {
		const bootstrap = validateSessionBootstrap(candidate);
		if (bootstrap.port < CHAT_DEFAULT_PORT || bootstrap.port > CHAT_MAX_PORT) {
			return undefined;
		}
		return bootstrap;
	} catch {
		return undefined;
	}
}

function resolveActionApi(api: ChatBrowserApi): ChatActionApi {
	const action = api.action ?? api.browserAction;
	if (!action) throw new Error("no action or browserAction API available");
	return action;
}

function keepaliveFrame(bootstrap: SessionBootstrap): string {
	return JSON.stringify({
		type: "keepalive",
		sessionId: bootstrap.sessionId,
		token: bootstrap.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	});
}

type ConfigWaiter = { key: string; settle(reply: ConfigRelayReply): void };

const CONFIG_ROUND_TRIP_TIMEOUT_MS = 5000;

export function registerChat(options: RegisterChatOptions = {}): ChatClient {
	const api = options.browserApi ?? (browser as unknown as ChatBrowserApi);
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const keepaliveIntervalMs =
		options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
	const maybeStartRecording =
		options.maybeStartRecording ?? defaultMaybeStartRecording;

	const bootstrapsBySession = new Map<string, SessionBootstrap>();
	const keepaliveEligible = new Set<string>();
	const configWaiters: ConfigWaiter[] = [];
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

	function failPendingConfigRequests(error: string): void {
		for (const waiter of configWaiters.splice(0)) {
			waiter.settle({ key: waiter.key, error });
		}
	}

	function openSocketWithKeepaliveTeardown(url: string): ChatClientSocket {
		const socket = openSocket(url);
		currentSocket = socket;
		const cleanup = () => {
			if (currentSocket === socket) currentSocket = undefined;
			stopKeepalive();
			failPendingConfigRequests("the daemon connection closed");
		};
		socket.addEventListener("close", cleanup);
		socket.addEventListener("error", cleanup);
		return socket;
	}

	function firstConfirmedBootstrap(): SessionBootstrap | undefined {
		for (const sessionId of keepaliveEligible) {
			const bootstrap = bootstrapsBySession.get(sessionId);
			if (bootstrap) return bootstrap;
		}
		return undefined;
	}

	function dispatchCommand(
		sessionId: string,
		commandLabel: string,
		params: Record<string, unknown>,
	): { ok: boolean; error?: string } {
		const socket = currentSocket;
		const bootstrap = bootstrapsBySession.get(sessionId);
		if (!socket || !bootstrap) {
			return {
				ok: false,
				error: "no chat session is open — start one to run a command",
			};
		}
		socket.send(
			JSON.stringify({
				type: "command-invocation",
				sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				commandLabel,
				params,
			}),
		);
		return { ok: true };
	}

	function requestDaemonConfig(
		kind: "config-get" | "config-set",
		key: string,
		value?: string,
	): Promise<ConfigRelayReply> {
		const socket = currentSocket;
		const bootstrap = firstConfirmedBootstrap();
		if (!socket || !bootstrap) {
			return Promise.resolve({
				key,
				error: "no chat session is open — start one to configure this",
			});
		}
		return new Promise((resolve) => {
			let settled = false;
			const waiter: ConfigWaiter = {
				key,
				settle(reply) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					const idx = configWaiters.indexOf(waiter);
					if (idx !== -1) configWaiters.splice(idx, 1);
					resolve(reply);
				},
			};
			const timer = setTimeout(
				() =>
					waiter.settle({ key, error: "daemon config round trip timed out" }),
				CONFIG_ROUND_TRIP_TIMEOUT_MS,
			);
			configWaiters.push(waiter);
			socket.send(
				JSON.stringify({
					type: kind,
					sessionId: bootstrap.sessionId,
					token: bootstrap.token,
					protocolVersion: CHAT_PROTOCOL_VERSION,
					key,
					...(kind === "config-set" ? { value } : {}),
				}),
			);
		});
	}

	const client = createChatClient({
		openSocket: openSocketWithKeepaliveTeardown,
	});

	client.onFrame((frame) => {
		void api.runtime.sendMessage({ type: MSG.frame, frame }).catch(() => {});
		if (frame.type === "config-result") {
			configWaiters
				.find((w) => w.key === frame.key)
				?.settle({ key: frame.key, value: frame.value, error: frame.error });
			return;
		}
		if (frame.type === "session-closed") {
			bootstrapsBySession.delete(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			void api.storage.session.remove(chatSessionKey(frame.sessionId));
			if (keepaliveEligible.size === 0) stopKeepalive();
			return;
		}
		if (frame.type === "session-pending") {
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
		if (!isExtensionPageSender(sender, api)) return undefined;
		const payload = message as Record<string, unknown>;
		try {
			switch (payload.type) {
				case MSG.clientConnect: {
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
				case MSG.configRequest: {
					const kind = payload.request;
					if (kind !== "config-get" && kind !== "config-set") return undefined;
					if (typeof payload.key !== "string" || payload.key.length === 0) {
						return undefined;
					}
					if (kind === "config-set" && typeof payload.value !== "string") {
						return undefined;
					}
					void requestDaemonConfig(
						kind,
						payload.key,
						typeof payload.value === "string" ? payload.value : undefined,
					).then(sendResponse);
					return true;
				}
				case MSG.commandInvocation: {
					if (
						typeof payload.sessionId !== "string" ||
						typeof payload.commandLabel !== "string" ||
						payload.commandLabel.length === 0
					) {
						return undefined;
					}
					const params =
						typeof payload.params === "object" &&
						payload.params !== null &&
						!Array.isArray(payload.params)
							? (payload.params as Record<string, unknown>)
							: {};
					sendResponse(
						dispatchCommand(payload.sessionId, payload.commandLabel, params),
					);
					return undefined;
				}
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
