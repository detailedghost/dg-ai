import {
	CHAT_ATTACH_PATH,
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	CHAT_SESSIONS_CLEAR_PATH,
	CHAT_SESSIONS_PATH,
	type ChatFrame,
	type SessionBootstrap,
	emitRedacted,
	noteSecret,
	validateAttachRequest,
	validateSessionBootstrap,
} from "@dg/common";
import { fetchDaemonHealth, findDaemonPort } from "@/lib/daemon-port";
import {
	handshakeOutcome,
	redactSecrets,
} from "@/lib/features/chat-connection";
import { browser } from "wxt/browser";
import {
	createInboxHandler,
	type InboxBrowserApi,
	type InboxResultFrame,
} from "./inbox";
import {
	createProtoHandler,
	type ProtoBrowserApi,
	type ProtoBrowserRequest,
	type ProtoResultFrame,
} from "./proto";
import { maybeStartRecording as defaultMaybeStartRecording } from "@/lib/background/recording";
import {
	CHAT_SESSION_KEY_PREFIX,
	type ConfigRelayReply,
	type PairingSession,
	MSG,
} from "@/lib/chat-messages";
import {
	type ChatClient,
	type ChatClientSocket,
	createChatClient,
	defaultOpenSocket,
} from "@/lib/features/chat-client";

export const CHAT_PAGE_PATH = "chat.html";
export const OVERWATCH_PAGE_PATH = "overwatch.html";

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
		getManifest?(): { version: string };
		sendMessage(message: unknown): Promise<unknown>;
	};
	tabs: {
		create(props: { url: string }): unknown;
		query?(queryInfo: {
			url: string;
		}): Promise<{ id?: number; windowId?: number }[]>;
		update?(tabId: number, props: { active: boolean }): unknown;
	};
	windows?: {
		update(windowId: number, props: { focused: boolean }): unknown;
	};
	sidePanel?: {
		open(options: { tabId?: number }): Promise<void>;
	};
	storage: {
		session: {
			get?(): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
			remove(keys: string | string[]): Promise<void>;
		};
	};
};

export type OverwatchBrowserApi = {
	runtime: Pick<ChatBrowserApi["runtime"], "getURL" | "sendMessage">;
	tabs: ChatBrowserApi["tabs"];
	windows?: ChatBrowserApi["windows"];
};

export type OverwatchOpenCompletion = {
	requestId: string;
	ok: boolean;
	error?: string;
};

export async function handleOverwatchFrame(
	frame: ChatFrame,
	api: OverwatchBrowserApi,
): Promise<OverwatchOpenCompletion | undefined> {
	if (frame.type === "overwatch-state") {
		await api.runtime
			.sendMessage({ type: MSG.overwatchState, frame })
			.catch(() => undefined);
		return undefined;
	}
	if (frame.type !== "overwatch-open") return undefined;
	const url = api.runtime.getURL(OVERWATCH_PAGE_PATH);
	const matches = api.tabs.query ? await api.tabs.query({ url }) : [];
	const existing = matches[0];
	if (existing?.id !== undefined && api.tabs.update) {
		await api.tabs.update(existing.id, { active: true });
		if (existing.windowId !== undefined && api.windows) {
			await api.windows.update(existing.windowId, { focused: true });
		}
		return { requestId: frame.requestId, ok: true };
	}
	await api.tabs.create({ url });
	return { requestId: frame.requestId, ok: true };
}

export async function handleOverwatchFrameSafely(
	frame: ChatFrame,
	api: OverwatchBrowserApi,
	complete: (result: OverwatchOpenCompletion) => void = () => undefined,
): Promise<void> {
	try {
		const result = await handleOverwatchFrame(frame, api);
		if (result) complete(result);
	} catch (error) {
		if (frame.type === "overwatch-open") {
			complete({
				requestId: frame.requestId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		emitRedacted(
			(line) => console.error(line),
			`[dg-ai-extension] overwatch frame failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export type RegisterChatOptions = {
	browserApi?: ChatBrowserApi;
	openSocket?: (url: string) => ChatClientSocket;
	keepaliveIntervalMs?: number;
	maybeStartRecording?: (tab?: chrome.tabs.Tab) => Promise<boolean>;
	inboxHandler?: (
		frame: Extract<ChatFrame, { type: "inbox-browser-request" }>,
	) => Promise<InboxResultFrame>;
	protoHandler?: (
		request: ProtoBrowserRequest,
		onProgress: (status: string) => void,
	) => Promise<ProtoResultFrame>;
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

/** Registers authenticated session transports, including correlated inbox replies that bypass the chat message queue. */
export function registerChat(options: RegisterChatOptions = {}): ChatClient {
	const api = options.browserApi ?? (browser as unknown as ChatBrowserApi);
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const keepaliveIntervalMs =
		options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
	const maybeStartRecording =
		options.maybeStartRecording ?? defaultMaybeStartRecording;

	const inboxHandler =
		options.inboxHandler ??
		createInboxHandler({ browserApi: api as unknown as InboxBrowserApi });
	const protoHandler =
		options.protoHandler ??
		createProtoHandler({ browserApi: api as unknown as ProtoBrowserApi });
	const pendingInbox = new Set<string>();
	const pendingProto = new Set<string>();
	const bootstrapsBySession = new Map<string, SessionBootstrap>();
	function holdBootstrap(bootstrap: SessionBootstrap): void {
		noteSecret(bootstrap.token);
		bootstrapsBySession.set(bootstrap.sessionId, bootstrap);
	}
	const keepaliveEligible = new Set<string>();
	const configWaiters: ConfigWaiter[] = [];
	const pendingOverwatchOpenCompletions: OverwatchOpenCompletion[] = [];
	let currentSocket: ChatClientSocket | undefined;
	let currentPairingId: string | undefined;
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
			if (currentSocket !== socket) return;
			currentSocket = undefined;
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

	function sendOverwatchOpenCompletion(
		result: OverwatchOpenCompletion,
		socket = currentSocket,
		bootstrap = firstConfirmedBootstrap(),
	): boolean {
		if (!socket || !bootstrap) return false;
		socket.send(
			JSON.stringify({
				type: "overwatch-open-result",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				...result,
			}),
		);
		return true;
	}

	function flushOverwatchOpenCompletions(): void {
		while (pendingOverwatchOpenCompletions.length > 0) {
			const result = pendingOverwatchOpenCompletions[0];
			if (!result || !sendOverwatchOpenCompletion(result)) return;
			pendingOverwatchOpenCompletions.shift();
		}
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
		extensionVersion: api.runtime.getManifest?.().version,
		keepaliveIntervalMs,
	});

	function knownTokens(): string[] {
		return [...bootstrapsBySession.values()].map((bootstrap) => bootstrap.token);
	}

	function safeError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return redactSecrets(message, knownTokens());
	}

	async function daemonPort(): Promise<number | undefined> {
		const hinted =
			firstConfirmedBootstrap()?.port ??
			[...bootstrapsBySession.values()][0]?.port;
		if (hinted !== undefined && (await fetchDaemonHealth(hinted))) return hinted;
		return findDaemonPort();
	}

	async function postDaemon(
		path: string,
		body: unknown,
	): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
		const port = await daemonPort();
		if (port === undefined) {
			return {
				ok: false,
				error: "Daemon unreachable. Start it with dg-agent start, then retry.",
			};
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const text = await response.text();
			if (!response.ok) {
				return { ok: false, error: redactSecrets(text, knownTokens()) };
			}
			try {
				return { ok: true, value: text.length === 0 ? {} : JSON.parse(text) };
			} catch {
				return {
					ok: false,
					error: "The daemon returned a response the extension could not read.",
				};
			}
		} catch (error) {
			return { ok: false, error: safeError(error) };
		}
	}

	async function adoptBootstraps(value: unknown): Promise<number> {
		const list = Array.isArray(value)
			? value
			: typeof value === "object" &&
					value !== null &&
					Array.isArray((value as { sessions?: unknown }).sessions)
				? (value as { sessions: unknown[] }).sessions
				: [value];
		let adopted = 0;
		for (const item of list) {
			const bootstrap = asSessionBootstrap(item);
			if (!bootstrap) continue;
			await api.storage.session.set({
				[chatSessionKey(bootstrap.sessionId)]: bootstrap,
			});
			currentPairingId ??= bootstrap.sessionId;
			holdBootstrap(bootstrap);
			client.connect(bootstrap);
			adopted += 1;
		}
		if (adopted > 0) broadcastPairingStatus();
		return adopted;
	}

	async function presentChat(tab?: { id?: number }): Promise<void> {
		if (api.sidePanel) {
			try {
				await api.sidePanel.open(
					tab?.id !== undefined ? { tabId: tab.id } : {},
				);
				return;
			} catch {
				// Opening the side panel needs a user gesture Chrome will accept.
			}
		}
		const url = api.runtime.getURL(CHAT_PAGE_PATH);
		const matches = api.tabs.query ? await api.tabs.query({ url }) : [];
		const existing = matches[0];
		if (existing?.id !== undefined && api.tabs.update) {
			await api.tabs.update(existing.id, { active: true });
			if (existing.windowId !== undefined && api.windows) {
				await api.windows.update(existing.windowId, { focused: true });
			}
			return;
		}
		await api.tabs.create({ url });
	}

	function pairingStatus() {
		const state = client.getConnectionState();
		const sessions: PairingSession[] = [...bootstrapsBySession.values()].map(
			({ sessionId, agentIdentity }) => ({
				sessionId,
				agentIdentity,
				current: sessionId === currentPairingId,
				connected: state === "connected" && keepaliveEligible.has(sessionId),
			}),
		);
		return {
			state,
			connected: sessions.some((session) => session.connected),
			sessions,
		};
	}

	function broadcastPairingStatus(detail?: string): void {
		void api.runtime
			.sendMessage({
				type: MSG.connection,
				...pairingStatus(),
				...(detail ? { detail } : {}),
			})
			.catch(() => {});
	}

	client.onConnectionChange((_state, detail) => broadcastPairingStatus(detail));

	client.onFrame((frame) => {
		if (frame.type === "inbox-browser-request") {
			const bootstrap = bootstrapsBySession.get(frame.sessionId);
			const socket = currentSocket;
			const key = JSON.stringify([frame.sessionId, frame.requestId]);
			if (
				!bootstrap ||
				!socket ||
				!keepaliveEligible.has(frame.sessionId) ||
				pendingInbox.has(key)
			)
				return;
			pendingInbox.add(key);
			void inboxHandler(frame)
				.then((result) => {
					if (
						currentSocket !== socket ||
						bootstrapsBySession.get(frame.sessionId) !== bootstrap ||
						!keepaliveEligible.has(frame.sessionId)
					)
						return;
					socket.send(
						JSON.stringify({
							...result,
							sessionId: frame.sessionId,
							requestId: frame.requestId,
							token: bootstrap.token,
						}),
					);
				})
				.catch(() => {
					if (
						currentSocket === socket &&
						bootstrapsBySession.get(frame.sessionId) === bootstrap &&
						keepaliveEligible.has(frame.sessionId)
					) {
						try {
							socket.send(
								JSON.stringify({
									type: "inbox-browser-result",
									sessionId: frame.sessionId,
									requestId: frame.requestId,
									protocolVersion: CHAT_PROTOCOL_VERSION,
									token: bootstrap.token,
									ok: false,
									error:
										"Proton extension request failed. Open or reload the mail tab and retry.",
								}),
							);
						} catch {
							// A closed socket cannot carry its pending result.
						}
					}
				})
				.finally(() => pendingInbox.delete(key));
			return;
		}
		if (frame.type === "proto-browser-request") {
			const bootstrap = bootstrapsBySession.get(frame.sessionId);
			const socket = currentSocket;
			const requestKey = JSON.stringify([frame.sessionId, frame.requestId]);
			if (
				!bootstrap ||
				!socket ||
				!keepaliveEligible.has(frame.sessionId) ||
				pendingProto.has(requestKey)
			) {
				return;
			}
			pendingProto.add(requestKey);
			const sendProto = (payload: Record<string, unknown>): void => {
				if (
					currentSocket !== socket ||
					bootstrapsBySession.get(frame.sessionId) !== bootstrap ||
					!keepaliveEligible.has(frame.sessionId)
				) {
					return;
				}
				try {
					socket.send(
						JSON.stringify({
							...payload,
							sessionId: frame.sessionId,
							requestId: frame.requestId,
							token: bootstrap.token,
							protocolVersion: CHAT_PROTOCOL_VERSION,
						}),
					);
				} catch {
					// A closed socket cannot carry its pending result.
				}
			};
			void protoHandler(
				{
					phase: frame.phase,
					slug: frame.slug,
					markedUrl: frame.markedUrl,
					...(frame.timeoutMs !== undefined
						? { timeoutMs: frame.timeoutMs }
						: {}),
				},
				(status) => {
					sendProto({ type: "proto-browser-progress", status });
				},
			)
				.then((result) => {
					sendProto({ type: "proto-browser-result", ...result });
				})
				.catch(() => {
					sendProto({
						type: "proto-browser-result",
						ok: false,
						error:
							"Prototype extension request failed before the browser reported a result.",
					});
				})
				.finally(() => pendingProto.delete(requestKey));
			return;
		}
		if (frame.type === "error" && handshakeOutcome(frame) === "drop") {
			client.forgetSession(frame.sessionId);
			bootstrapsBySession.delete(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			void api.storage.session.remove(chatSessionKey(frame.sessionId));
			if (keepaliveEligible.size === 0) stopKeepalive();
			broadcastPairingStatus();
		}
		void api.runtime.sendMessage({ type: MSG.frame, frame }).catch(() => {});
		const requestSocket = currentSocket;
		const requestBootstrap = firstConfirmedBootstrap();
		void handleOverwatchFrameSafely(frame, api, (result) => {
			if (
				currentSocket === requestSocket &&
				sendOverwatchOpenCompletion(result, requestSocket, requestBootstrap)
			) {
				return;
			}
			pendingOverwatchOpenCompletions.push(result);
			flushOverwatchOpenCompletions();
		});
		if (frame.type === "config-result") {
			configWaiters
				.find((w) => w.key === frame.key)
				?.settle({ key: frame.key, value: frame.value, error: frame.error });
			return;
		}
		if (frame.type === "session-closed" || frame.type === "session-disconnected") {
			bootstrapsBySession.delete(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			void api.storage.session.remove(chatSessionKey(frame.sessionId));
			if (keepaliveEligible.size === 0) stopKeepalive();
			broadcastPairingStatus();
			return;
		}
		if (frame.type === "session-pending") {
			const requester = bootstrapsBySession.get(frame.sessionId);
			if (requester) {
				holdBootstrap({
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
		broadcastPairingStatus();
		currentSocket?.send(keepaliveFrame(bootstrap));
		flushOverwatchOpenCompletions();
		if (keepaliveTimer === undefined) {
			keepaliveTimer = setInterval(sendKeepalives, keepaliveIntervalMs);
		}
	});

	resolveActionApi(api).onClicked.addListener((tab) => {
		void (async () => {
			if (await maybeStartRecording(tab)) return;
			await presentChat(tab);
		})();
	});

	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (isMarkerCapturedMessage(message)) {
			const bootstrap = asSessionBootstrap(message.bootstrap);
			if (!bootstrap) return undefined;
			void (async () => {
				try {
					await api.storage.session.set({
						[chatSessionKey(bootstrap.sessionId)]: bootstrap,
					});
					await presentChat();
					currentPairingId = bootstrap.sessionId;
					holdBootstrap(bootstrap);
					client.connect(bootstrap);
					broadcastPairingStatus();
					sendResponse({ ok: true });
				} catch (error) {
					sendResponse({
						ok: false,
						error: safeError(error),
					});
				}
			})();
			return true;
		}

		if (typeof message !== "object" || message === null) return undefined;
		if (!isExtensionPageSender(sender, api)) return undefined;
		const payload = message as Record<string, unknown>;
		try {
			switch (payload.type) {
				case MSG.connectionRequest:
					sendResponse(pairingStatus());
					return undefined;
				case MSG.bootstrapsRequest:
					sendResponse({ bootstraps: [...bootstrapsBySession.values()] });
					return undefined;
				case MSG.connectionRetry: {
					void (async () => {
						const port = await daemonPort();
						if (port === undefined) {
							sendResponse({
								ok: false,
								error:
									"Daemon unreachable. Start it with dg-agent start, then retry.",
							});
							return;
						}
						for (const bootstrap of bootstrapsBySession.values()) {
							const next = { ...bootstrap, port };
							holdBootstrap(next);
							client.connect(next);
						}
						client.retryNow();
						broadcastPairingStatus();
						sendResponse({ ok: true, state: client.getConnectionState() });
					})();
					return true;
				}
				case MSG.sessionCatalog: {
					void (async () => {
						const port = await daemonPort();
						if (port === undefined) {
							sendResponse({ sessions: [] });
							return;
						}
						try {
							const response = await fetch(
								`http://127.0.0.1:${port}${CHAT_SESSIONS_PATH}`,
							);
							const text = await response.text();
							if (!response.ok) {
								sendResponse({
									sessions: [],
									error: redactSecrets(text, knownTokens()),
								});
								return;
							}
							const body = JSON.parse(text) as { sessions?: unknown };
							sendResponse({
								sessions: Array.isArray(body.sessions) ? body.sessions : [],
							});
						} catch (error) {
							sendResponse({ sessions: [], error: safeError(error) });
						}
					})();
					return true;
				}
				case MSG.sessionAttach: {
					void (async () => {
						try {
							const request = validateAttachRequest({
								intent: "attach",
								...(typeof payload.code === "string" ? { code: payload.code } : {}),
								...(typeof payload.sessionId === "string"
									? { sessionId: payload.sessionId }
									: {}),
								...(payload.all === true ? { all: true } : {}),
							});
							const result = await postDaemon(CHAT_ATTACH_PATH, request);
							if (!result.ok) {
								sendResponse({ ok: false, error: result.error });
								return;
							}
							const adopted = await adoptBootstraps(result.value);
							sendResponse(
								adopted > 0
									? { ok: true }
									: {
											ok: false,
											error: "The daemon did not return a session.",
										},
							);
						} catch (error) {
							sendResponse({ ok: false, error: safeError(error) });
						}
					})();
					return true;
				}
				case MSG.sessionLaunch: {
					void (async () => {
						try {
							const workset =
								typeof payload.workset === "string" ? payload.workset : undefined;
							const result =
								typeof payload.code === "string"
									? await postDaemon(CHAT_ATTACH_PATH, {
											intent: "create",
											code: payload.code,
											...(workset ? { workset } : {}),
										})
									: await postDaemon(CHAT_SESSIONS_PATH, {
											...(workset ? { workset } : {}),
										});
							if (!result.ok) {
								sendResponse({ ok: false, error: result.error });
								return;
							}
							const adopted = await adoptBootstraps(result.value);
							sendResponse(
								adopted > 0
									? { ok: true }
									: {
											ok: false,
											error: "The daemon did not create a session.",
										},
							);
						} catch (error) {
							sendResponse({ ok: false, error: safeError(error) });
						}
					})();
					return true;
				}
				case MSG.sessionClear: {
					void (async () => {
						const result = await postDaemon(CHAT_SESSIONS_CLEAR_PATH, {});
						if (!result.ok) {
							sendResponse({ ok: false, error: result.error });
							return;
						}
						const closedIds = Array.isArray(
							(result.value as { closed?: unknown }).closed,
						)
							? ((result.value as { closed: unknown[] }).closed.filter(
									(id): id is string => typeof id === "string",
								))
							: [];
						for (const sessionId of closedIds) {
							client.forgetSession(sessionId);
							bootstrapsBySession.delete(sessionId);
							keepaliveEligible.delete(sessionId);
							await api.storage.session.remove(chatSessionKey(sessionId));
						}
						if (keepaliveEligible.size === 0) stopKeepalive();
						broadcastPairingStatus();
						sendResponse({ ok: true, closed: closedIds });
					})();
					return true;
				}
				case MSG.clientConnect: {
					const bootstrap = asSessionBootstrap(payload.bootstrap);
					if (!bootstrap) return undefined;
					currentPairingId ??= bootstrap.sessionId;
					holdBootstrap(bootstrap);
					client.connect(bootstrap);
					broadcastPairingStatus();
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
				case MSG.sessionDisconnect: {
					if (
						typeof payload.sessionId !== "string" ||
						!bootstrapsBySession.has(payload.sessionId)
					) {
						sendResponse({ ok: false });
						return undefined;
					}
					const sessionId = payload.sessionId;
					void (async () => {
						try {
							await client.disconnectSession(sessionId);
							await api.storage.session.remove(chatSessionKey(sessionId));
							bootstrapsBySession.delete(sessionId);
							keepaliveEligible.delete(sessionId);
							if (keepaliveEligible.size === 0) stopKeepalive();
							broadcastPairingStatus();
							sendResponse({ ok: true });
						} catch {
							sendResponse({ ok: false });
						}
					})();
					return true;
				}
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
				error: safeError(error),
			});
		}
		return undefined;
	});

	if (api.storage?.session?.get) {
		void api.storage.session
			.get()
			.then((stored) => {
				for (const [key, value] of Object.entries(stored ?? {})) {
					if (!key.startsWith(CHAT_SESSION_KEY_PREFIX)) continue;
					const bootstrap = asSessionBootstrap(value);
					if (!bootstrap || bootstrapsBySession.has(bootstrap.sessionId)) continue;
					holdBootstrap(bootstrap);
					client.connect(bootstrap);
				}
			})
			.catch(() => undefined);
	}

	return client;
}
