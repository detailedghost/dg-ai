import { fetchDaemonHealth, findDaemonPort } from "@/lib/daemon-port";
import { handshakeOutcome, reconnectDelayMs } from "@/lib/features/chat-connection";
import {
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_PROTOCOL_VERSION,
	CHAT_WS_PATH,
	OVERWATCH_SESSION_ID,
	type ChatFrame,
	type ConnectionDropInput,
	type DropMessage,
	createSerialQueue,
	emitRedacted,
	formatConnectionDrop,
	noteSecret,
	type SessionBootstrap,
	type SessionRole,
	validateChatFrame,
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

export type { ChatHealth, DaemonName } from "@/lib/daemon-port";

export type ChatClientOptions = {
	openSocket?: (url: string) => ChatClientSocket;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	randomJitter?: () => number;
	extensionVersion?: string;
	keepaliveIntervalMs?: number;
};

export type ChatClient = {
	connect(bootstrap: SessionBootstrap): void;
	onFrame(listener: (frame: ChatFrame) => void): void;
	onConnectionChange(listener: ConnectionListener): void;
	sendUserMessage(
		sessionId: string,
		body: string,
		opts?: SendUserMessageOptions,
	): string;
	getConnectionState(): ChatConnectionState;
	requestNewSession(
		requestingSessionId: string,
		role: SessionRole,
		workset?: string,
	): void;
	closeSession(sessionId: string): void;
	disconnectSession(sessionId: string): Promise<void>;
	forgetSession(sessionId: string): void;
	retryNow(): void;
};

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

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
	let knownInstanceId: string | undefined;
	const capabilities = new Map<string, string>();
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
				sidePanel: { lifecycle: "unknown" },
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
			if (generation !== socketGeneration) return;
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
			if (socketGeneration !== generationAtEnqueue) return;
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
		});
	}

	function flushOutbox(): void {
		for (const msg of outbox) sendQueuedMessage(msg);
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
		flushOutbox();
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
			if (everConnected && knownInstanceId === undefined) {
				openAndBind();
				return;
			}
			const generation = socketGeneration;
			void findDaemonPort(knownInstanceId).then((rediscovered) => {
				if (generation !== socketGeneration || capabilities.size === 0) return;
				if (rediscovered !== undefined) port = rediscovered;
				openAndBind();
			});
		}, delay);
	}

	function scheduleReconnect(): void {
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
			for (const listener of frameListeners) listener(frame);
			return;
		}

		const isOverwatchFrame =
			frame.sessionId === OVERWATCH_SESSION_ID &&
			(frame.type === "overwatch-state" || frame.type === "overwatch-open");
		if (!isOverwatchFrame && !capabilities.has(frame.sessionId)) return;

		if (frame.type === "session-disconnected") {
			const waiter = disconnectWaiters.get(frame.sessionId);
			if (!waiter) return;
			capabilities.delete(frame.sessionId);
			for (let i = outbox.length - 1; i >= 0; i--) {
				if (outbox[i]?.sessionId === frame.sessionId) outbox.splice(i, 1);
			}
			disconnectWaiters.delete(frame.sessionId);
			waiter.resolve();
			if (capabilities.size === 0) {
				if (retryTimer !== undefined) clearTimeout(retryTimer);
				retryTimer = undefined;
				const previous = socket;
				socket = null;
				socketGeneration += 1;
				hasAttemptInFlight = false;
				previous?.close?.();
				setConnectionState("daemon-not-running");
			}
		}
		if (frame.type === "error") {
			disconnectWaiters.get(frame.sessionId)?.reject(new Error("The daemon did not confirm disconnect. Update dg-daemon and retry."));
			disconnectWaiters.delete(frame.sessionId);
		}

		if (frame.type === "session-pending") {
			capabilities.set(frame.newSession.sessionId, frame.newSession.token);
			noteSecret(frame.newSession.token);
		}

		if (frame.type === "ack") {
			const idx = outbox.findIndex((m) => m.messageId === frame.messageId);
			if (idx !== -1) outbox.splice(idx, 1);
		}

		if (frame.type === "session-closed") {
			capabilities.delete(frame.sessionId);
			for (let i = outbox.length - 1; i >= 0; i--) {
				if (outbox[i]?.sessionId === frame.sessionId) outbox.splice(i, 1);
			}
		}

		for (const listener of frameListeners) listener(frame);
	}

	function openAndBind(): void {
		socketGeneration += 1;
		let opened: ChatClientSocket;
		try {
			opened = openSocket(socketUrl());
		} catch {
			setConnectionState("daemon-not-running");
			socket = null;
			scheduleRetry();
			return;
		}
		socket = opened;
		opened.addEventListener("open", () => {
			if (socket === opened) handleOpen();
		});
		opened.addEventListener("close", () => {
			if (socket === opened) scheduleReconnect();
		});
		opened.addEventListener("message", (event) => {
			if (socket === opened) handleMessage(event);
		});
		opened.addEventListener("error", () => {
			if (socket === opened) handleError();
		});
	}

	return {
		connect(bootstrap: SessionBootstrap): void {
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
			if (connectionState === "connected") sendQueuedMessage(msg);
			return messageId;
		},

		getConnectionState(): ChatConnectionState {
			return connectionState;
		},

		requestNewSession(
			requestingSessionId: string,
			role: SessionRole,
			workset?: string,
		): void {
			const token = capabilities.get(requestingSessionId);
			if (!token) {
				throw new Error(
					`requestNewSession: session ${requestingSessionId} is not captured by this client`,
				);
			}
			if (connectionState !== "connected") {
				throw new Error("requestNewSession: not connected to the daemon");
			}
			send({
				type: "session-create",
				sessionId: requestingSessionId,
				token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				role,
				...(workset ? { workset } : {}),
			});
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
			disconnectWaiters.delete(sessionId);
			for (let i = outbox.length - 1; i >= 0; i--) {
				if (outbox[i]?.sessionId === sessionId) outbox.splice(i, 1);
			}
			if (capabilities.size === 0) {
				if (retryTimer !== undefined) clearTimeout(retryTimer);
				retryTimer = undefined;
				const previous = socket;
				socket = null;
				socketGeneration += 1;
				hasAttemptInFlight = false;
				previous?.close?.();
				setConnectionState("daemon-not-running");
			}
		},

		retryNow(): void {
			if (capabilities.size === 0) {
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
