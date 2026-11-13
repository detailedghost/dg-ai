import {
	CHAT_ASSETS_PATH,
	CHAT_DEFAULT_PORT,
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
	PW_EXT_READ_VERBS,
	PW_EXT_WRITE_VERBS,
	validateChatFrame,
} from "@dg/common";
import { codedPageUrl } from "@dg/pages/chat-marker";
import {
	fetchDaemonHealth,
	findDaemonPort,
	findPinnedDaemonPort,
	portHasDaemonId,
} from "@dg/pages/daemon-port";
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
	type PairedBootstrap,
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
import { createUnmaskGrants } from "./unmask-grants";
import { createWebMcpGrants } from "./webmcp-approval";
import { forgetAgentTabsAndShims } from "./dialog-shim";
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
const LINK_RETRY_ALARM = "dg-link-retry";
const LINK_RETRY_PERIOD_MINUTES = 0.5;
const DAEMON_ID_KEY = "daemon:id";
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
	alarms?: {
		create(name: string, info: { periodInMinutes: number }): unknown;
		clear(name: string): unknown;
		onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
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

function withoutPin({ daemonId: _pinned, ...bootstrap }: PairedBootstrap): SessionBootstrap {
	return bootstrap;
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
export function registerDaemonLink(
	options: RegisterDaemonLinkOptions = {},
): {
	client: ChatClient;
	adopt(bootstrap: SessionBootstrap): Promise<void>;
	daemonPort(): Promise<number | undefined>;
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
	const unmaskGrants = createUnmaskGrants({
		storage: api.storage as unknown as AgentTabsStorage,
	});
	const webmcpGrants = createWebMcpGrants({
		storage: api.storage as unknown as AgentTabsStorage,
	});
	const pwExtApi = api as unknown as PwExtBrowserApi;
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
			browserApi: pwExtApi,
			agentTabs,
			grants: unmaskGrants,
			webmcpGrants,
		}),
		...options.relayHandlers,
	};
	const bootstrapsBySession = new Map<string, PairedBootstrap>();
	function holdBootstrap(bootstrap: PairedBootstrap): void {
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
			if (bootstrap) return withoutPin(bootstrap);
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

	let pinnedDaemonId: string | undefined;
	const adoptingSessions = new Set<string>();

	async function pinDaemon(daemonId: string): Promise<void> {
		pinnedDaemonId = daemonId;
		await api.storage.local
			.set({ [DAEMON_ID_KEY]: daemonId })
			.catch(logStoreError);
	}

	const client = createChatClient({
		openSocket: openSocketWithKeepaliveTeardown,
		validateFrame: validateChatFrame,
		admitPort: async (port) => {
			await ready;
			if (pinnedDaemonId !== undefined) {
				return portHasDaemonId(port, pinnedDaemonId);
			}
			const daemonId = (await fetchDaemonHealth(port))?.daemonId;
			if (daemonId === undefined) return false;
			void pinDaemon(daemonId);
			return true;
		},
		findPort: async () => {
			await ready;
			return pinnedDaemonId === undefined
				? findDaemonPort()
				: findPinnedDaemonPort(pinnedDaemonId);
		},
		link: { onSessionAdopt: (bootstrap) => void adoptPushed(bootstrap) },
		extensionVersion: api.runtime.getManifest?.().version,
		pwExtVerbs: [...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS],
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
		for (const cleanup of [
			() =>
				forgetAgentTabsAndShims({
					browserApi: pwExtApi,
					storage: api.storage as unknown as AgentTabsStorage,
					agentTabs,
					sessionId,
				}),
			() => unmaskGrants.forget(sessionId),
			() => webmcpGrants.forget(sessionId),
		])
			void Promise.resolve()
				.then(cleanup)
				.catch((error: unknown) =>
					emitRedacted(
						(line) => console.warn(line),
						`[dg-chat] agent tab cleanup failed: ${describeError(error)}`,
						knownTokens(),
					),
				);
	}

	async function daemonPort(): Promise<number | undefined> {
		await ready;
		const daemonId = pinnedDaemonId;
		if (daemonId === undefined) return findDaemonPort();
		const hinted =
			firstConfirmedBootstrap()?.port ??
			[...bootstrapsBySession.values()][0]?.port;
		if (hinted !== undefined && (await portHasDaemonId(hinted, daemonId))) {
			return hinted;
		}
		return findPinnedDaemonPort(daemonId);
	}

	async function pinToDaemon(bootstrap: SessionBootstrap): Promise<PairedBootstrap> {
		const daemonId = (await fetchDaemonHealth(bootstrap.port))?.daemonId;
		if (daemonId === undefined) {
			throw new Error("The daemon at this port did not identify itself.");
		}
		await ready;
		if (pinnedDaemonId !== undefined && pinnedDaemonId !== daemonId) {
			throw new Error("This agent belongs to a different daemon than your other pairings.");
		}
		if (pinnedDaemonId === undefined) void pinDaemon(daemonId);
		return { ...bootstrap, daemonId };
	}

	function holdAndConnect(bootstrap: PairedBootstrap): void {
		holdBootstrap(bootstrap);
		client.connect(bootstrap);
		broadcastPairingStatus();
	}

	async function adopt(bootstrap: SessionBootstrap): Promise<void> {
		const checked = asSessionBootstrap(bootstrap);
		if (!checked) throw new Error("The pairing bootstrap is not valid.");
		holdAndConnect(await pinToDaemon(checked));
	}

	async function adoptPushed(bootstrap: PairedBootstrap): Promise<void> {
		await ready;
		const { sessionId } = bootstrap;
		if (
			bootstrap.daemonId !== pinnedDaemonId ||
			bootstrapsBySession.has(sessionId) ||
			adoptingSessions.has(sessionId)
		) {
			return;
		}
		adoptingSessions.add(sessionId);
		try {
			if (await pairingStore.isDismissed({ sessionId })) return;
			await adopt(withoutPin(bootstrap));
		} catch (error) {
			logStoreError(error);
		} finally {
			adoptingSessions.delete(sessionId);
		}
	}

	async function daemonChanged(): Promise<boolean> {
		if (
			pinnedDaemonId === undefined ||
			client.getConnectionState() === "connected"
		) {
			return false;
		}
		if ((await findPinnedDaemonPort(pinnedDaemonId)) !== undefined) return false;
		return (await findDaemonPort()) !== undefined;
	}

	async function trustLiveDaemon(): Promise<
		{ ok: true } | { ok: false; error: string }
	> {
		const port = await findDaemonPort();
		const daemonId =
			port === undefined ? undefined : (await fetchDaemonHealth(port))?.daemonId;
		if (port === undefined || daemonId === undefined) {
			return { ok: false, error: DAEMON_UNREACHABLE };
		}
		await pinDaemon(daemonId);
		for (const held of [...bootstrapsBySession.values()]) {
			if (held.daemonId === daemonId) continue;
			client.forgetSession(held.sessionId);
			bootstrapsBySession.delete(held.sessionId);
			presenceBySession.delete(held.sessionId);
			keepaliveEligible.delete(held.sessionId);
			dispatcher.cancelSession(held.sessionId);
			forgetStoredPairing(held.sessionId);
			forgetAgentTabs(held.sessionId);
		}
		client.openLink?.(port);
		broadcastPairingStatus();
		return { ok: true };
	}

	async function openChat(
		sessionId: unknown,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const bootstrap =
			typeof sessionId === "string"
				? bootstrapsBySession.get(sessionId)
				: undefined;
		if (!bootstrap) return { ok: false, error: "This agent is not paired." };
		const verifiedPort = await daemonPort();
		if (verifiedPort === undefined) {
			return { ok: false, error: DAEMON_UNREACHABLE };
		}
		const live =
			client.getConnectionState() === "connected" ? client.getPort?.() : undefined;
		const port = live ?? verifiedPort;
		const url = await codedPageUrl({
			port,
			path: "/chat",
			bootstrap: withoutPin(bootstrap),
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

	let linkRetryArmed = false;
	function syncLinkRetryAlarm(state: ReturnType<ChatClient["getConnectionState"]>): void {
		if (!api.alarms) return;
		if (state === "connected") {
			if (!linkRetryArmed) return;
			linkRetryArmed = false;
			void Promise.resolve(api.alarms.clear(LINK_RETRY_ALARM)).catch(() => {});
		} else if (!linkRetryArmed) {
			linkRetryArmed = true;
			api.alarms.create(LINK_RETRY_ALARM, {
				periodInMinutes: LINK_RETRY_PERIOD_MINUTES,
			});
		}
	}

	client.onConnectionChange((state, detail) => {
		syncLinkRetryAlarm(state);
		broadcastPairingStatus(detail);
	});

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
		const confirmedBootstrap = firstConfirmedBootstrap();
		const livePort = client.getPort?.();
		const requestBootstrap =
			confirmedBootstrap && livePort !== undefined
				? { ...confirmedBootstrap, port: livePort }
				: confirmedBootstrap;
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
		if (frame.type === "session-closed") {
			void pairingStore
				.release({ sessionId: frame.sessionId })
				.catch(logStoreError);
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

	const ready = (async () => {
		const stored = await pairingStore.list();
		const kept = (await api.storage.local.get(DAEMON_ID_KEY))?.[DAEMON_ID_KEY];
		const daemonId =
			typeof kept === "string" && kept.length > 0 ? kept : stored[0]?.daemonId;
		if (daemonId === undefined) return;
		if (daemonId === kept) pinnedDaemonId = daemonId;
		else void pinDaemon(daemonId);
		for (const bootstrap of stored) {
			if (bootstrap.daemonId !== daemonId) continue;
			if (bootstrapsBySession.has(bootstrap.sessionId)) continue;
			holdBootstrap(bootstrap);
			client.connect(bootstrap);
		}
	})().catch(logStoreError);

	async function startLink(): Promise<void> {
		await ready;
		if (client.getPort?.() !== undefined) return;
		const port = await daemonPort();
		if (client.getPort?.() !== undefined) return;
		client.openLink?.(port ?? CHAT_DEFAULT_PORT);
	}
	void startLink();
	syncLinkRetryAlarm(client.getConnectionState());
	api.alarms?.onAlarm.addListener((alarm) => {
		if (alarm.name !== LINK_RETRY_ALARM) return;
		if (client.getConnectionState() === "connected") return;
		void (async () => {
			await ready;
			const port = await daemonPort();
			client.openLink?.(port ?? CHAT_DEFAULT_PORT);
		})();
	});
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
					void ready
						.then(daemonChanged)
						.then((changed) =>
							sendResponse({ ...pairingStatus(), daemonChanged: changed }),
						);
					return true;
				case MSG.trustDaemon:
					if (!isPopupSender(sender, api.runtime.getURL(""))) return undefined;
					void trustLiveDaemon().then(sendResponse, (error: unknown) =>
						sendResponse({ ok: false, error: safeError(error) }),
					);
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
						const removal = Promise.all([
							pairingStore.remove({ sessionId }),
							pairingStore.dismiss({ sessionId }),
						]);
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

	return { client, adopt, daemonPort, pending: dispatcher.pending };
}
