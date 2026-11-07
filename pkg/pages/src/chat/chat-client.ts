import { fetchDaemonHealth, findDaemonPort } from "../daemon-port";
import { handshakeOutcome, reconnectDelayMs } from "./chat-connection";
import {
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_PROTOCOL_VERSION,
	CHAT_WS_PATH,
	OVERWATCH_SESSION_ID,
	type ChatFrame,
	type ConnectionDropInput,
	type DropMessage,
	createSerialQueue,
	describeError,
	emitRedacted,
	formatConnectionDrop,
	noteSecret,
	type SessionAdopt,
	type SessionBootstrap,
	type SessionRole,
	validateChatFrame,
	validateSessionAdopt,
} from "@dg/common";

const UTF8_ENCODER = new TextEncoder();

export type ChatClientSocket = {
	send(data: string): void;
	close?(): void;
	addEventListener(
		type: "open" | "close" | "message" | "error",
		listener: (event?: unknown) => void,
	): void;
};

export type ChatConnectionState =
	| "connected"
	| "reconnecting"
	| "daemon-not-running";

export type ConnectionListener = (
	state: ChatConnectionState,
	detail?: string,
) => void;

export type SendUserMessageOptions = {
	messageId?: string;
	subagentName?: string;
};

export type SendUserMessageResult =
	| { ok: true }
	| { ok: false; error: string; reason?: "timeout" };

export type SendAndWaitOptions = SendUserMessageOptions & { timeoutMs?: number };

export type { ChatHealth, DaemonName } from "../daemon-port";

export type ChatClientOptions = {
	openSocket?: (
		url: string,
		held: ReadonlyMap<string, string>,
	) => ChatClientSocket;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	randomJitter?: () => number;
	extensionVersion?: string;
	keepaliveIntervalMs?: number;
	admitPort?: (port: number) => Promise<boolean>;
	findPort?: () => Promise<number | undefined>;
	link?: { onSessionAdopt(bootstrap: SessionAdopt["bootstrap"]): void };
};

export type ChatClient = {
	connect(bootstrap: SessionBootstrap): void;
	/** Opens, or reopens, the single socket on a port with no session; needs the link option. */
	openLink?(port: number): void;
	addSession(bootstrap: SessionBootstrap): void;
	onFrame(listener: (frame: ChatFrame) => void): void;
	onConnectionChange(listener: ConnectionListener): void;
	sendUserMessage(
		sessionId: string,
		body: string,
		opts?: SendUserMessageOptions,
	): string;
	getConnectionState(): ChatConnectionState;
	/** The daemon port the socket uses now, after any instance-matched rediscovery. */
	getPort?(): number | undefined;
	isSessionConfirmed?(sessionId: string): boolean;
	sendUserMessageAndWait(
		sessionId: string,
		body: string,
		opts?: SendAndWaitOptions,
	): Promise<SendUserMessageResult>;
	closeSession(sessionId: string): void;
	disconnectSession(sessionId: string): Promise<void>;
	forgetSession(sessionId: string): void;
	retryNow(): void;
	sendCommandInvocation?(
		sessionId: string,
		commandLabel: string,
		params?: Record<string, unknown>,
	): Promise<{ ok: true } | { ok: false; error: string }>;
};

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_ACK_TIMEOUT_MS = 5000;

function chatSocketUrl(port: number): string {
	return `ws://127.0.0.1:${port}${CHAT_WS_PATH}`;
}

function buildConnectFrame(
	sessionId: string,
	token: string,
	extensionVersion?: string,
): Record<string, unknown> {
	return {
		type: "connect",
		sessionId,
		token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...(extensionVersion ? { extensionVersion } : {}),
	};
}

export function defaultOpenSocket(url: string): ChatClientSocket {
	return new WebSocket(url) as unknown as ChatClientSocket;
}

type QueuedMessage = {
	sessionId: string;
	messageId: string;
	body: string;
	subagentName?: string;
};

type AckWaiter = {
	timeoutMs: number;
	settle(result: SendUserMessageResult): void;
	timer?: ReturnType<typeof setTimeout>;
};

type OutboundFrame = Record<string, unknown>;

export function createChatClient(options: ChatClientOptions = {}): ChatClient {
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
	const randomJitter = options.randomJitter ?? Math.random;

	let socket: ChatClientSocket | null = null;
	let port: number | undefined;
	let connectionState: ChatConnectionState = "daemon-not-running";
	let reconnectAttempt = 0;
	let hasAttemptInFlight = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let socketGeneration = 0;
	let everConnected = false;
	let socketAdmitted = true;
	let knownInstanceId: string | undefined;
	let lastSessionList: Extract<ChatFrame, { type: "session-list" }> | undefined;
	const capabilities = new Map<string, string>();
	const confirmedSessions = new Set<string>();
	const ackWaiters = new Map<string, AckWaiter>();
	const disconnectWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
	const frameListeners = new Set<(frame: ChatFrame) => void>();
	const connectionListeners = new Set<ConnectionListener>();
	const outbox: QueuedMessage[] = [];
	const recent: DropMessage[] = [];
	const enqueueSend = createSerialQueue((err) =>
		emitRedacted(
			(line) => console.error(line),
			`[dg-chat] outbound send failed: ${err instanceof Error ? err.message : String(err)}`,
			[...capabilities.values()],
		),
	);

	function noteMessage(direction: "in" | "out", type: string): void {
		recent.push({ direction, type, at: new Date().toISOString() });
		if (recent.length > 8) recent.shift();
	}

	function logDrop(phase: ConnectionDropInput["phase"], reason: string): void {
		emitRedacted(
			(line) => console.warn(line),
			formatConnectionDrop({
				phase,
				reason,
				sessionIds: [...capabilities.keys()],
				port,
				socket: {
					readyState: phase === "dropped" ? "closed" : connectionState,
					url: port === undefined ? undefined : socketUrl(),
				},
				serviceWorker: { lifecycle: "active", active: true },
				lastMessages: recent,
				timers: {
					keepaliveMs: options.keepaliveIntervalMs,
					reconnectAttempt,
					nextDelayMs: reconnectDelayMs(
						reconnectAttempt,
						backoffBaseMs,
						backoffMaxMs,
						0,
					),
					heartbeat:
						options.keepaliveIntervalMs === undefined ? "unknown" : "armed",
				},
				daemon: {
					reachable: connectionState !== "daemon-not-running",
					port,
				},
				agent: {
					attached: capabilities.size > 0,
					presence: connectionState,
				},
				secrets: [...capabilities.values()],
			}),
		);
	}

	function setConnectionState(
		state: ChatConnectionState,
		detail?: string,
	): void {
		connectionState = state;
		for (const listener of connectionListeners) listener(state, detail);
	}

	function socketUrl(): string {
		return chatSocketUrl(port as number);
	}

	function send(frame: OutboundFrame): void {
		if (typeof frame.type === "string") noteMessage("out", frame.type);
		const generation = socketGeneration;
		void enqueueSend(async () => {
			if (generation !== socketGeneration || !socketAdmitted) return;
			socket?.send(JSON.stringify(frame));
		});
	}

	function sendConnectHandshake(sessionId: string, token: string): void {
		send(buildConnectFrame(sessionId, token, options.extensionVersion));
	}

	function sendHistoryRequest(sessionId: string, token: string): void {
		send({
			type: "history-request",
			sessionId,
			token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		});
	}

	function sendQueuedMessage(msg: QueuedMessage): void {
		const generationAtEnqueue = socketGeneration;
		void enqueueSend(async () => {
			if (!outbox.includes(msg)) return;
			if (socketGeneration !== generationAtEnqueue || !socketAdmitted) return;
			const token = capabilities.get(msg.sessionId);
			if (!token) return;
			socket?.send(
				JSON.stringify({
					type: "user-message",
					sessionId: msg.sessionId,
					token,
					protocolVersion: CHAT_PROTOCOL_VERSION,
					messageId: msg.messageId,
					body: msg.body,
					...(msg.subagentName ? { subagentName: msg.subagentName } : {}),
				}),
			);
			startAckTimer(msg.messageId);
		});
	}

	function startAckTimer(messageId: string): void {
		const waiter = ackWaiters.get(messageId);
		if (!waiter || waiter.timer !== undefined) return;
		waiter.timer = setTimeout(() => {
			const idx = outbox.findIndex((m) => m.messageId === messageId);
			if (idx !== -1) outbox.splice(idx, 1);
			waiter.settle({ ok: false, reason: "timeout", error: "The daemon did not confirm this message." });
		}, waiter.timeoutMs);
	}

	function dropOutbox(sessionId: string): void {
		for (let i = outbox.length - 1; i >= 0; i--) {
			const msg = outbox[i];
			if (msg?.sessionId !== sessionId) continue;
			outbox.splice(i, 1);
			ackWaiters
				.get(msg.messageId)
				?.settle({ ok: false, error: "The session closed before the daemon confirmed this message." });
		}
	}

	function flushOutbox(sessionIds: ReadonlySet<string>): void {
		for (const msg of outbox) {
			if (sessionIds.has(msg.sessionId)) sendQueuedMessage(msg);
		}
	}

	function confirmSessions(
		frame: Extract<ChatFrame, { type: "session-list" }>,
	): void {
		const fresh = new Set<string>();
		for (const summary of frame.sessions) {
			if (!capabilities.has(summary.sessionId)) continue;
			if (confirmedSessions.has(summary.sessionId)) continue;
			confirmedSessions.add(summary.sessionId);
			fresh.add(summary.sessionId);
		}
		if (fresh.size > 0) flushOutbox(fresh);
	}

	function handleOpen(): void {
		setConnectionState("connected");
		reconnectAttempt = 0;
		everConnected = true;
		if (port !== undefined) {
			void fetchDaemonHealth(port).then((health) => {
				if (health) knownInstanceId = health.instanceId;
			});
		}
		for (const [sessionId, token] of capabilities) {
			sendConnectHandshake(sessionId, token);
			sendHistoryRequest(sessionId, token);
		}
		if (options.link) send({ type: "link-ready" });
	}

	function scheduleRetry(): void {
		const delay = reconnectDelayMs(
			reconnectAttempt,
			backoffBaseMs,
			backoffMaxMs,
			randomJitter(),
		);
		reconnectAttempt += 1;
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (
				!options.findPort &&
				everConnected &&
				knownInstanceId === undefined
			) {
				openAndBind();
				return;
			}
			const generation = socketGeneration;
			const rediscover =
				options.findPort ?? (() => findDaemonPort(knownInstanceId));
			void rediscover().then((rediscovered) => {
				if (generation !== socketGeneration || (capabilities.size === 0 && !options.link)) return;
				if (rediscovered !== undefined) port = rediscovered;
				openAndBind();
			});
		}, delay);
	}

	function scheduleReconnect(): void {
		confirmedSessions.clear();
		logDrop("dropped", "socket closed");
		for (const waiter of disconnectWaiters.values()) waiter.reject(new Error("The connection closed before disconnect was confirmed."));
		disconnectWaiters.clear();
		setConnectionState("reconnecting");
		scheduleRetry();
	}

	function handleError(): void {
		setConnectionState(
			"reconnecting",
			`could not reach the daemon on port ${port}`,
		);
	}

	function emitSessionList(): void {
		if (!lastSessionList) return;
		for (const listener of frameListeners) listener(lastSessionList);
	}

	function routeSessionAdopt(parsed: unknown): void {
		if (!options.link) return;
		try {
			options.link.onSessionAdopt(validateSessionAdopt(parsed).bootstrap);
		} catch (err) {
			emitRedacted(
				(line) => console.warn(line),
				`[dg-chat] dropping invalid session-adopt: ${describeError(err)}`,
				[...capabilities.values()],
			);
		}
	}

	function closeSocketWithoutSessions(): void {
		if (capabilities.size > 0 || options.link) return;
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		retryTimer = undefined;
		const previous = socket;
		socket = null;
		socketGeneration += 1;
		hasAttemptInFlight = false;
		previous?.close?.();
		setConnectionState("daemon-not-running");
	}

	function handleMessage(event: unknown): void {
		const raw = (event as { data?: unknown } | undefined)?.data;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw as string);
		} catch (err) {
			emitRedacted(
				(line) => console.warn(line),
				`[dg-chat] dropping unparseable frame: ${err instanceof Error ? err.message : String(err)}`,
				[...capabilities.values()],
			);
			return;
		}
		if ((parsed as { type?: unknown } | null)?.type === "session-adopt") {
			routeSessionAdopt(parsed);
			return;
		}
		let frame: ChatFrame;
		try {
			frame = validateChatFrame(parsed);
		} catch (err) {
			emitRedacted(
				(line) => console.warn(line),
				`[dg-chat] dropping invalid frame: ${err instanceof Error ? err.message : String(err)}`,
				[...capabilities.values()],
			);
			return;
		}
		noteMessage("in", frame.type);
		if (frame.type === "error" && handshakeOutcome(frame) === "drop") {
			logDrop("handshake", frame.message ?? frame.code ?? "handshake rejected");
		}
		if (frame.type === "session-list") {
			confirmSessions(frame);
			lastSessionList = frame;
			emitSessionList();
			return;
		}

		const isOverwatchFrame =
			frame.sessionId === OVERWATCH_SESSION_ID &&
			(frame.type === "overwatch-state" || frame.type === "overwatch-open");
		const isLinkClose = options.link !== undefined && frame.type === "session-closed";
		if (!isOverwatchFrame && !isLinkClose && !capabilities.has(frame.sessionId))
			return;

		if (frame.type === "session-disconnected") {
			const waiter = disconnectWaiters.get(frame.sessionId);
			if (!waiter) return;
			capabilities.delete(frame.sessionId);
			confirmedSessions.delete(frame.sessionId);
			dropOutbox(frame.sessionId);
			disconnectWaiters.delete(frame.sessionId);
			waiter.resolve();
			closeSocketWithoutSessions();
		}
		if (frame.type === "error") {
			disconnectWaiters.get(frame.sessionId)?.reject(new Error("The daemon did not confirm disconnect. Update dg-daemon and retry."));
			disconnectWaiters.delete(frame.sessionId);
		}

		if (frame.type === "session-pending") {
			capabilities.set(frame.newSession.sessionId, frame.newSession.token);
			noteSecret(frame.newSession.token);
			confirmedSessions.add(frame.newSession.sessionId);
			flushOutbox(new Set([frame.newSession.sessionId]));
		}

		if (frame.type === "ack") {
			const idx = outbox.findIndex((m) => m.messageId === frame.messageId);
			if (idx !== -1) outbox.splice(idx, 1);
			ackWaiters.get(frame.messageId)?.settle({ ok: true });
		}

		if (frame.type === "session-closed") {
			capabilities.delete(frame.sessionId);
			confirmedSessions.delete(frame.sessionId);
			dropOutbox(frame.sessionId);
		}

		for (const listener of frameListeners) listener(frame);
	}

	function openAndBind(): void {
		socketGeneration += 1;
		confirmedSessions.clear();
		let opened: ChatClientSocket;
		try {
			opened = openSocket(socketUrl(), capabilities);
		} catch {
			setConnectionState("daemon-not-running");
			socket = null;
			scheduleRetry();
			return;
		}
		socket = opened;
		socketAdmitted = options.admitPort === undefined;
		let closed = false;
		opened.addEventListener("open", () => {
			if (socket !== opened) return;
			const { admitPort } = options;
			if (!admitPort || port === undefined) {
				handleOpen();
				return;
			}
			void admitPort(port).then(
				(accepted) => {
					if (socket !== opened || closed) return;
					if (!accepted) {
						opened.close?.();
						return;
					}
					socketAdmitted = true;
					handleOpen();
				},
				() => {
					if (socket === opened) opened.close?.();
				},
			);
		});
		opened.addEventListener("close", () => {
			closed = true;
			if (socket === opened) scheduleReconnect();
		});
		opened.addEventListener("message", (event) => {
			if (socket === opened && socketAdmitted) handleMessage(event);
		});
		opened.addEventListener("error", () => {
			if (socket === opened) handleError();
		});
	}

	function queueUserMessage(
		sessionId: string,
		body: string,
		opts: SendUserMessageOptions,
	): string {
		if (!capabilities.has(sessionId) || disconnectWaiters.has(sessionId)) {
			throw new Error(
				`sendUserMessage: session ${sessionId} is not captured by this client`,
			);
		}
		const bodyBytes = UTF8_ENCODER.encode(body).length;
		if (bodyBytes > CHAT_MAX_MESSAGE_BODY_BYTES) {
			throw new Error(
				`sendUserMessage: body is ${bodyBytes} bytes, exceeding CHAT_MAX_MESSAGE_BODY_BYTES (${CHAT_MAX_MESSAGE_BODY_BYTES})`,
			);
		}
		const messageId = opts.messageId ?? crypto.randomUUID();
		const msg: QueuedMessage = {
			sessionId,
			messageId,
			body,
			subagentName: opts.subagentName,
		};
		outbox.push(msg);
		if (connectionState === "connected" && confirmedSessions.has(sessionId))
			sendQueuedMessage(msg);
		return messageId;
	}

	function connectSession(bootstrap: SessionBootstrap): void {
		capabilities.set(bootstrap.sessionId, bootstrap.token);
		noteSecret(bootstrap.token);
		if (hasAttemptInFlight) {
			if (connectionState === "connected") {
				sendConnectHandshake(bootstrap.sessionId, bootstrap.token);
				sendHistoryRequest(bootstrap.sessionId, bootstrap.token);
			}
			return;
		}
		hasAttemptInFlight = true;
		port = bootstrap.port;
		openAndBind();
	}

	function reopenAt(next: number): void {
		port = next;
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		retryTimer = undefined;
		const previous = socket;
		socket = null;
		socketGeneration += 1;
		hasAttemptInFlight = true;
		previous?.close?.();
		openAndBind();
	}

	return {
		connect: connectSession,

		openLink(next: number): void {
			if (options.link) reopenAt(next);
		},

		addSession(bootstrap: SessionBootstrap): void {
			if (capabilities.has(bootstrap.sessionId)) return;
			connectSession(bootstrap);
		},

		onFrame(listener: (frame: ChatFrame) => void): void {
			frameListeners.add(listener);
		},

		onConnectionChange(listener: ConnectionListener): void {
			connectionListeners.add(listener);
		},

		sendUserMessage(
			sessionId: string,
			body: string,
			opts: SendUserMessageOptions = {},
		): string {
			return queueUserMessage(sessionId, body, opts);
		},

		sendUserMessageAndWait(
			sessionId: string,
			body: string,
			{ timeoutMs = DEFAULT_ACK_TIMEOUT_MS, ...opts }: SendAndWaitOptions = {},
		): Promise<SendUserMessageResult> {
			const messageId = opts.messageId ?? crypto.randomUUID();
			return new Promise((resolve) => {
				const waiter: AckWaiter = {
					timeoutMs,
					settle(result) {
						clearTimeout(waiter.timer);
						ackWaiters.delete(messageId);
						resolve(result);
					},
				};
				ackWaiters.set(messageId, waiter);
				try {
					queueUserMessage(sessionId, body, { ...opts, messageId });
				} catch (error) {
					waiter.settle({
						ok: false,
						error: describeError(error),
					});
				}
			});
		},

		isSessionConfirmed(sessionId: string): boolean {
			return connectionState === "connected" && confirmedSessions.has(sessionId);
		},

		getConnectionState(): ChatConnectionState {
			return connectionState;
		},

		getPort(): number | undefined {
			return port;
		},

		disconnectSession(sessionId: string): Promise<void> {
			const token = capabilities.get(sessionId);
			if (!token || connectionState !== "connected" || disconnectWaiters.has(sessionId)) {
				return Promise.reject(new Error("Session is not connected or disconnect is pending."));
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					disconnectWaiters.delete(sessionId);
					reject(new Error("Disconnect was not confirmed. Update dg-daemon and retry."));
				}, 5000);
				disconnectWaiters.set(sessionId, {
					resolve() { clearTimeout(timer); resolve(); },
					reject(error) { clearTimeout(timer); reject(error); },
				});
				send({ type: "session-disconnect", sessionId, token, protocolVersion: CHAT_PROTOCOL_VERSION });
			});
		},

		sendCommandInvocation(sessionId, commandLabel, params = {}) {
			const token = capabilities.get(sessionId);
			if (!token) {
				return Promise.resolve({
					ok: false,
					error: "no chat session is open — start one to run a command",
				});
			}
			if (connectionState !== "connected") {
				return Promise.resolve({
					ok: false,
					error: "the daemon is not connected — retry once the chat reconnects",
				});
			}
			send({
				type: "command-invocation",
				sessionId,
				token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				commandLabel,
				params,
			});
			return Promise.resolve({ ok: true });
		},

		closeSession(sessionId: string): void {
			const token = capabilities.get(sessionId);
			if (!token) {
				throw new Error(
					`closeSession: session ${sessionId} is not captured by this client`,
				);
			}
			if (connectionState !== "connected") {
				throw new Error("closeSession: not connected to the daemon");
			}
			send({
				type: "session-close",
				sessionId,
				token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			});
		},

		forgetSession(sessionId: string): void {
			capabilities.delete(sessionId);
			confirmedSessions.delete(sessionId);
			disconnectWaiters.delete(sessionId);
			dropOutbox(sessionId);
			closeSocketWithoutSessions();
		},

		retryNow(): void {
			if (capabilities.size === 0 && !options.link) {
				setConnectionState("daemon-not-running");
				return;
			}
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			retryTimer = undefined;
			const previous = socket;
			socket = null;
			socketGeneration += 1;
			hasAttemptInFlight = true;
			previous?.close?.();
			openAndBind();
		},
	};
}
