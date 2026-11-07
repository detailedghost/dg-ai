import {
	CHAT_ASSETS_PATH,
	CHAT_ATTACH_PATH,
	CHAT_MAX_ASSET_BYTES,
	CHAT_PROTOCOL_VERSION,
	type FeatureNamed,
	RELAY_FEATURES,
	type RelayFeatureName,
	type SessionBootstrap,
	type SessionPresence,
	describeError,
	emitRedacted,
	noteSecret,
	validateAttachRequest,
} from "@dg/common";
import { localPageUrl } from "@dg/pages/chat-marker";
import { fetchDaemonHealth, findDaemonPort } from "@dg/pages/daemon-port";
import {
	handshakeOutcome,
	redactSecrets,
} from "@dg/pages/chat/chat-connection";
import { browser } from "wxt/browser";
import {
	type AgentTabsBrowserApi,
	type AgentTabsStorage,
	createAgentTabs,
} from "./agent-tabs";
import { createInboxHandler, type InboxBrowserApi } from "./inbox";
import {
	asSessionBootstrap,
	createPairingStore,
	type PairingStorage,
	type PairingStore,
} from "./pairing-store";
import {
	createPages,
	type OverwatchOpenCompletion,
	openLocalPage,
	type PagesBrowserApi,
} from "./local-pages";
import { isExtensionPageSender, isPopupSender } from "./popup-sender";
import { createProtoHandler, type ProtoBrowserApi } from "./proto";
import {
	createPwExtHandler,
	type PwExtBrowserApi,
	type PwExtContext,
} from "./pw-ext";
import {
	createRelayDispatcher,
	type RelayHandler,
	type RelayRun,
} from "./relay-dispatch";
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

const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
const DAEMON_UNREACHABLE =
	"Daemon unreachable. Start it with dg-agent start, then retry.";

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
		onStartup?: { addListener(listener: () => void): void };
		onInstalled?: { addListener(listener: () => void): void };
	};
	storage: {
		local: PairingStorage;
		session: Omit<PairingStorage, "get"> & Partial<Pick<PairingStorage, "get">>;
	};
};

export type RegisterDaemonLinkOptions = {
	browserApi?: ChatBrowserApi;
	openSocket?: (url: string) => ChatClientSocket;
	keepaliveIntervalMs?: number;
	relayHandlers?: Partial<{
		[N in RelayFeatureName]: RelayHandler<FeatureNamed<N>>;
	}>;
	pairingStore?: PairingStore;
};

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
export function registerDaemonLink(
	options: RegisterDaemonLinkOptions = {},
): {
	client: ChatClient;
	adopt(bootstrap: SessionBootstrap): Promise<void>;
	pending(sessionId?: string): RelayRun[];
} {
	const api = options.browserApi ?? (browser as unknown as ChatBrowserApi);
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const keepaliveIntervalMs =
		options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;

	const pairingStore =
		options.pairingStore ?? createPairingStore({ storage: api.storage });
	const pages = createPages({ browserApi: api });
	const agentTabs = createAgentTabs({
		browserApi: api as unknown as AgentTabsBrowserApi,
		storage: api.storage as unknown as AgentTabsStorage,
	});
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
			agentTabs,
		}),
		...options.relayHandlers,
	};
	const bootstrapsBySession = new Map<string, SessionBootstrap>();
	function holdBootstrap(bootstrap: SessionBootstrap): void {
		noteSecret(bootstrap.token);
		bootstrapsBySession.set(bootstrap.sessionId, bootstrap);
	}
	const presenceBySession = new Map<string, SessionPresence | undefined>();
	const keepaliveEligible = new Set<string>();
	const configWaiters: ConfigWaiter[] = [];
	const pendingOverwatchOpenCompletions: OverwatchOpenCompletion[] = [];
	let currentSocket: ChatClientSocket | undefined;
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
		const message = describeError(error);
		return redactSecrets(message, knownTokens());
	}

	function logStoreError(error: unknown): void {
		emitRedacted(
			(line) => console.warn(line),
			`[dg-chat] pairing storage failed: ${describeError(error)}`,
			knownTokens(),
		);
	}

	function forgetStoredPairing(sessionId: string): void {
		void pairingStore.remove({ sessionId }).catch(logStoreError);
	}

	function forgetAgentTabs(sessionId: string): void {
		void Promise.resolve()
			.then(() => agentTabs.forget({ sessionId }))
			.catch((error: unknown) =>
				emitRedacted(
					(line) => console.warn(line),
					`[dg-chat] agent tab cleanup failed: ${describeError(error)}`,
					knownTokens(),
				),
			);
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
			return { ok: false, error: DAEMON_UNREACHABLE };
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
			holdBootstrap(bootstrap);
			client.connect(bootstrap);
			adopted += 1;
		}
		if (adopted > 0) broadcastPairingStatus();
		return adopted;
	}
	function holdAndConnect(bootstrap: SessionBootstrap): void {
		holdBootstrap(bootstrap);
		client.connect(bootstrap);
		broadcastPairingStatus();
	}

	async function adopt(bootstrap: SessionBootstrap): Promise<void> {
		const checked = asSessionBootstrap(bootstrap);
		if (!checked) throw new Error("The pairing bootstrap is not valid.");
		holdAndConnect(checked);
	}

	async function openChat(
		sessionId: unknown,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const bootstrap =
			typeof sessionId === "string"
				? bootstrapsBySession.get(sessionId)
				: undefined;
		if (!bootstrap) return { ok: false, error: "This agent is not paired." };
		if ((await daemonPort()) === undefined) {
			return { ok: false, error: DAEMON_UNREACHABLE };
		}
		const live =
			client.getConnectionState() === "connected" ? client.getPort?.() : undefined;
		const port = live ?? bootstrap.port;
		const url = localPageUrl({
			port,
			path: "/chat",
			bootstrap: { ...bootstrap, port },
		});
		await openLocalPage(api, {
			url,
			query: { url: `http://127.0.0.1:${port}/chat*` },
		});
		return { ok: true };
	}

	function pairingStatus() {
		const state = client.getConnectionState();
		const sessions: PairingSession[] = [...bootstrapsBySession.values()].map(
			({ sessionId, agentIdentity }) => ({
				sessionId,
				agentIdentity,
				connected: state === "connected" && keepaliveEligible.has(sessionId),
				presence: presenceBySession.get(sessionId),
				runs: dispatcher.pending(sessionId),
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
			presenceBySession.delete(frame.sessionId);
			if (frame.code === "invalid-session") {
				forgetStoredPairing(frame.sessionId);
				forgetAgentTabs(frame.sessionId);
			}
			if (keepaliveEligible.size === 0) stopKeepalive();
			broadcastPairingStatus();
		}
		const requestSocket = currentSocket;
		const requestBootstrap = firstConfirmedBootstrap();
		pages.onFrame(frame, {
			bootstrap: requestBootstrap,
			sendCompletion(result) {
				if (
					currentSocket === requestSocket &&
					sendOverwatchOpenCompletion(result, requestSocket, requestBootstrap)
				) {
					return;
				}
				pendingOverwatchOpenCompletions.push(result);
				flushOverwatchOpenCompletions();
			},
		});
		if (frame.type === "config-result") {
			configWaiters
				.find((w) => w.key === frame.key)
				?.settle({ key: frame.key, value: frame.value, error: frame.error });
			return;
		}
		if (frame.type === "session-closed" || frame.type === "session-disconnected") {
			bootstrapsBySession.delete(frame.sessionId);
			presenceBySession.delete(frame.sessionId);
			dispatcher.cancelSession(frame.sessionId);
			keepaliveEligible.delete(frame.sessionId);
			forgetStoredPairing(frame.sessionId);
			forgetAgentTabs(frame.sessionId);
			if (keepaliveEligible.size === 0) stopKeepalive();
			broadcastPairingStatus();
			return;
		}
		if (frame.type !== "session-list") return;
		const presenceChanged = frame.sessions.some(
			({ sessionId, presence }) =>
				bootstrapsBySession.has(sessionId) &&
				presenceBySession.get(sessionId) !== presence,
		);
		for (const { sessionId, presence } of frame.sessions) {
			if (bootstrapsBySession.has(sessionId)) {
				presenceBySession.set(sessionId, presence);
			}
		}
		if (presenceChanged) broadcastPairingStatus();
		const sessionId = frame.sessionId;
		const bootstrap = bootstrapsBySession.get(sessionId);
		if (!bootstrap || keepaliveEligible.has(sessionId)) return;
		keepaliveEligible.add(sessionId);
		void pairingStore.put(bootstrap).catch(logStoreError);
		broadcastPairingStatus();
		currentSocket?.send(keepaliveFrame(bootstrap));
		flushOverwatchOpenCompletions();
		if (keepaliveTimer === undefined) {
			keepaliveTimer = setInterval(sendKeepalives, keepaliveIntervalMs);
		}
	});

	const ready = pairingStore
		.list()
		.then((stored) => {
			for (const bootstrap of stored) {
				if (bootstrapsBySession.has(bootstrap.sessionId)) continue;
				holdBootstrap(bootstrap);
				client.connect(bootstrap);
			}
		})
		.catch(logStoreError);
	const wakeWorker = () => void ready;
	api.runtime.onStartup?.addListener(wakeWorker);
	api.runtime.onInstalled?.addListener(wakeWorker);

	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (typeof message !== "object" || message === null) return undefined;
		if (!isExtensionPageSender(sender, api.runtime.getURL(""))) return undefined;
		const payload = message as Record<string, unknown>;
		try {
			switch (payload.type) {
				case MSG.connectionRequest:
					void ready.then(() => sendResponse(pairingStatus()));
					return true;
				case MSG.connectionRetry: {
					void (async () => {
						const port = await daemonPort();
						if (port === undefined) {
							sendResponse({ ok: false, error: DAEMON_UNREACHABLE });
							return;
						}
						for (const bootstrap of bootstrapsBySession.values()) {
							const next = { ...bootstrap, port };
							holdBootstrap(next);
							client.connect(next);
							if (keepaliveEligible.has(bootstrap.sessionId)) {
								void pairingStore.put(next).catch(logStoreError);
							}
						}
						client.retryNow();
						broadcastPairingStatus();
						sendResponse({ ok: true, state: client.getConnectionState() });
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
				case MSG.openChat:
					if (!isPopupSender(sender, api.runtime.getURL(""))) return undefined;
					void openChat(payload.sessionId).then(sendResponse, (error: unknown) =>
						sendResponse({ ok: false, error: safeError(error) }),
					);
					return true;
				case MSG.sessionDisconnect: {
					if (!isPopupSender(sender, api.runtime.getURL(""))) return undefined;
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
						} catch {
							client.forgetSession(sessionId);
						}
						dispatcher.cancelSession(sessionId);
						const removal = pairingStore.remove({ sessionId });
						forgetAgentTabs(sessionId);
						bootstrapsBySession.delete(sessionId);
						presenceBySession.delete(sessionId);
						keepaliveEligible.delete(sessionId);
						if (keepaliveEligible.size === 0) stopKeepalive();
						broadcastPairingStatus();
						try {
							await removal;
							sendResponse({ ok: true });
						} catch (error) {
							logStoreError(error);
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

	return { client, adopt, pending: dispatcher.pending };
}
