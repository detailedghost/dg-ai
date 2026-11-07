import {
	CHAT_ASSETS_PATH,
	CHAT_ATTACH_PATH,
	CHAT_MAX_ASSET_BYTES,
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	CHAT_SESSIONS_CLEAR_PATH,
	CHAT_SESSIONS_PATH,
	type FeatureNamed,
	RELAY_FEATURES,
	type RelayFeatureName,
	type SessionBootstrap,
	noteSecret,
	validateAttachRequest,
	validateSessionBootstrap,
} from "@dg/common";
import { fetchDaemonHealth, findDaemonPort } from "@dg/pages/daemon-port";
import {
	handshakeOutcome,
	redactSecrets,
} from "@dg/pages/chat/chat-connection";
import { browser } from "wxt/browser";
import { createInboxHandler, type InboxBrowserApi } from "./inbox";
import {
	createPairingStore,
	type PairingStorage,
	type PairingStore,
} from "./pairing-store";
import {
	createPages,
	type OverwatchOpenCompletion,
	type PagesBrowserApi,
} from "./pages";
import { createProtoHandler, type ProtoBrowserApi } from "./proto";
import {
	createPwExtHandler,
	type PwExtBrowserApi,
	type PwExtContext,
} from "./pw-ext";
import { createRelayDispatcher, type RelayHandler } from "./relay-dispatch";
import { maybeStartRecording as defaultMaybeStartRecording } from "@/lib/background/recording";
import {
	type ConfigRelayReply,
	type PairingSession,
	MSG,
} from "@dg/pages/chat-messages";
import {
	type ChatClient,
	type ChatClientSocket,
	createChatClient,
	defaultOpenSocket,
} from "@dg/pages/chat/chat-client";

export { CHAT_SESSION_KEY_PREFIX } from "@dg/pages/chat-messages";

const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

export type ChatBrowserApi = PagesBrowserApi & {
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
		getManifest?(): { version: string };
	};
	storage: {
		session: PairingStorage;
	};
};

export type RegisterChatOptions = {
	browserApi?: ChatBrowserApi;
	openSocket?: (url: string) => ChatClientSocket;
	keepaliveIntervalMs?: number;
	maybeStartRecording?: (tab?: chrome.tabs.Tab) => Promise<boolean>;
	relayHandlers?: Partial<{
		[N in RelayFeatureName]: RelayHandler<FeatureNamed<N>>;
	}>;
	pairingStore?: PairingStore;
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

function stagedAsset(
	bootstrap: SessionBootstrap,
	assetId: string,
	init?: { method: "DELETE" },
): Promise<Response> {
	return fetch(
		`http://127.0.0.1:${bootstrap.port}${CHAT_ASSETS_PATH}/${encodeURIComponent(assetId)}`,
		{
			...init,
			headers: {
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": bootstrap.token,
			},
		},
	);
}

function pwExtContext({
	bootstrap,
}: {
	bootstrap: SessionBootstrap;
}): PwExtContext {
	return {
		sessionId: bootstrap.sessionId,
		agentIdentity: bootstrap.agentIdentity,
		async fetchAsset(assetId) {
			const response = await stagedAsset(bootstrap, assetId);
			if (!response.ok) throw new Error("the staged file is not available");
			const blob = await response.blob();
			if (blob.size > CHAT_MAX_ASSET_BYTES)
				throw new Error("the staged file is too large");
			return blob;
		},
		async deleteAsset(assetId) {
			await stagedAsset(bootstrap, assetId, { method: "DELETE" });
		},
	};
}

/** Wires the daemon socket and the runtime message routing. */
export function registerChat(options: RegisterChatOptions = {}): ChatClient {
	const api = options.browserApi ?? (browser as unknown as ChatBrowserApi);
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const keepaliveIntervalMs =
		options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
	const maybeStartRecording =
		options.maybeStartRecording ?? defaultMaybeStartRecording;

	const pairingStore =
		options.pairingStore ?? createPairingStore({ storage: api.storage });
	const pages = createPages({ browserApi: api, maybeStartRecording });
	const relayHandlers: {
		[N in RelayFeatureName]: RelayHandler<FeatureNamed<N>>;
	} = {
		inbox: createInboxHandler({
			browserApi: api as unknown as InboxBrowserApi,
		}),
		proto: createProtoHandler({
			browserApi: api as unknown as ProtoBrowserApi,
		}),
		"pw-ext": createPwExtHandler({
			browserApi: api as unknown as PwExtBrowserApi,
		}),
		...options.relayHandlers,
	};
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

	const dispatcher = createRelayDispatcher({
		features: RELAY_FEATURES,
		handlers: relayHandlers,
		send: (frame) => currentSocket?.send(JSON.stringify(frame)),
		bootstrapFor: (sessionId) => bootstrapsBySession.get(sessionId),
		live(sessionId) {
			const socket = currentSocket;
			const bootstrap = bootstrapsBySession.get(sessionId);
			if (!socket || !bootstrap || !keepaliveEligible.has(sessionId))
				return undefined;
			return () =>
				currentSocket === socket &&
				bootstrapsBySession.get(sessionId) === bootstrap &&
				keepaliveEligible.has(sessionId);
		},
		contextFor: { "pw-ext": pwExtContext },
	});

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
			dispatcher.cancelSession();
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
			await pairingStore.put(bootstrap);
			currentPairingId ??= bootstrap.sessionId;
			holdBootstrap(bootstrap);
			client.connect(bootstrap);
			adopted += 1;
		}
		if (adopted > 0) broadcastPairingStatus();
		return adopted;
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
		if (dispatcher.dispatch(frame)) return;
		if (frame.type === "error" && handshakeOutcome(frame) === "drop") {
			client.forgetSession(frame.sessionId);
			bootstrapsBySession.delete(frame.sessionId);
			dispatcher.cancelSession(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			void pairingStore.remove({ sessionId: frame.sessionId });
			if (keepaliveEligible.size === 0) stopKeepalive();
			broadcastPairingStatus();
		}
		void api.runtime.sendMessage({ type: MSG.frame, frame }).catch(() => {});
		const requestSocket = currentSocket;
		const requestBootstrap = firstConfirmedBootstrap();
		pages.onFrame(frame, (result) => {
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
			dispatcher.cancelSession(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			void pairingStore.remove({ sessionId: frame.sessionId });
			if (keepaliveEligible.size === 0) stopKeepalive();
			broadcastPairingStatus();
			return;
		}
		if (frame.type === "session-pending") {
			const requester = bootstrapsBySession.get(frame.sessionId);
			if (requester) {
				const spawned = {
					...requester,
					sessionId: frame.newSession.sessionId,
					token: frame.newSession.token,
				};
				holdBootstrap(spawned);
				void pairingStore.put(spawned).catch(() => {});
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

	pages.registerActionClick();

	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (isMarkerCapturedMessage(message)) {
			const bootstrap = asSessionBootstrap(message.bootstrap);
			if (!bootstrap) return undefined;
			void (async () => {
				try {
					await pairingStore.put(bootstrap);
					await pages.presentChat();
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
							dispatcher.cancelSession(sessionId);
							keepaliveEligible.delete(sessionId);
							await pairingStore.remove({ sessionId });
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
							await pairingStore.remove({ sessionId });
							bootstrapsBySession.delete(sessionId);
							dispatcher.cancelSession(sessionId);
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

	void pairingStore
		.list()
		.then((stored) => {
			for (const candidate of stored) {
				const bootstrap = asSessionBootstrap(candidate);
				if (!bootstrap || bootstrapsBySession.has(bootstrap.sessionId)) continue;
				holdBootstrap(bootstrap);
				client.connect(bootstrap);
			}
		})
		.catch(() => undefined);

	return client;
}
