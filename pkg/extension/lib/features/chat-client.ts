import {
	CHAT_DEFAULT_PORT,
	CHAT_HEALTH_PATH,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	createSerialQueue,
	type SessionBootstrap,
	type SessionRole,
	validateChatFrame,
} from "@dg/common";

const UTF8_ENCODER = new TextEncoder();

export type ChatClientSocket = {
	send(data: string): void;
	addEventListener(
		type: "open" | "close" | "message" | "error",
		listener: (event?: unknown) => void,
	): void;
};

export type ChatConnectionState =
	| "connected"
	| "reconnecting"
	| "daemon-not-running";

export type SendUserMessageOptions = {
	messageId?: string;
	subagentName?: string;
};

export const DAEMON_HEALTH_NAMES = ["dg-daemon", "dg-server"] as const;

export type DaemonName = (typeof DAEMON_HEALTH_NAMES)[number];
export type ChatHealth = { daemon: DaemonName; instanceId: string };

function asDaemonName(value: unknown): DaemonName | undefined {
	return DAEMON_HEALTH_NAMES.find((name) => name === value);
}

export type ChatClientOptions = {
	openSocket?: (url: string) => ChatClientSocket;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	randomJitter?: () => number;
};

export type ChatClient = {
	connect(bootstrap: SessionBootstrap): void;
	onFrame(listener: (frame: ChatFrame) => void): void;
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
};

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

function chatSocketUrl(port: number): string {
	return `ws://127.0.0.1:${port}/ws`;
}

function buildConnectFrame(
	sessionId: string,
	token: string,
): Record<string, unknown> {
	return {
		type: "connect",
		sessionId,
		token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	};
}

export function defaultOpenSocket(url: string): ChatClientSocket {
	return new WebSocket(url) as unknown as ChatClientSocket;
}

const HEALTH_PROBE_TIMEOUT_MS = 2_000;

async function defaultFetchHealth(
	port: number,
): Promise<ChatHealth | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}${CHAT_HEALTH_PATH}`, {
			signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as {
			daemon?: unknown;
			instanceId?: unknown;
		};
		const daemon = asDaemonName(body.daemon);
		if (!daemon || typeof body.instanceId !== "string") return undefined;
		return { daemon, instanceId: body.instanceId };
	} catch {
		return undefined;
	}
}

async function findDaemonPort(
	preferInstanceId?: string,
): Promise<number | undefined> {
	const candidates = Array.from(
		{ length: CHAT_PORT_FALLBACK_COUNT + 1 },
		(_, index) => CHAT_DEFAULT_PORT + index,
	);
	const healths = await Promise.all(candidates.map(defaultFetchHealth));
	if (preferInstanceId !== undefined) {
		const preferred = candidates.find(
			(_, index) => healths[index]?.instanceId === preferInstanceId,
		);
		if (preferred !== undefined) return preferred;
	}
	const fallbackIndex = healths.findIndex((health) => health !== undefined);
	return fallbackIndex === -1 ? undefined : candidates[fallbackIndex];
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
	const frameListeners = new Set<(frame: ChatFrame) => void>();
	const outbox: QueuedMessage[] = [];
	const enqueueSend = createSerialQueue((err) =>
		console.error("[dg-chat] outbound send failed:", err),
	);

	function socketUrl(): string {
		return chatSocketUrl(port as number);
	}

	function send(frame: OutboundFrame): void {
		void enqueueSend(async () => {
			socket?.send(JSON.stringify(frame));
		});
	}

	function sendConnectHandshake(sessionId: string, token: string): void {
		send(buildConnectFrame(sessionId, token));
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
		connectionState = "connected";
		reconnectAttempt = 0;
		everConnected = true;
		if (port !== undefined) {
			void defaultFetchHealth(port).then((health) => {
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
		const raw = Math.min(backoffBaseMs * 2 ** reconnectAttempt, backoffMaxMs);
		const delay = Math.min(raw * (1 + randomJitter()), backoffMaxMs);
		reconnectAttempt += 1;
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (everConnected && knownInstanceId === undefined) {
				openAndBind();
				return;
			}
			void findDaemonPort(knownInstanceId).then((rediscovered) => {
				if (rediscovered !== undefined) port = rediscovered;
				openAndBind();
			});
		}, delay);
	}

	function scheduleReconnect(): void {
		connectionState = "reconnecting";
		scheduleRetry();
	}

	function handleError(): void {
		connectionState = "reconnecting";
	}

	function handleMessage(event: unknown): void {
		const raw = (event as { data?: unknown } | undefined)?.data;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw as string);
		} catch (err) {
			console.warn("[dg-chat] dropping unparseable frame:", err);
			return;
		}
		let frame: ChatFrame;
		try {
			frame = validateChatFrame(parsed);
		} catch (err) {
			console.warn("[dg-chat] dropping invalid frame:", err);
			return;
		}
		if (frame.type === "session-list") {
			for (const listener of frameListeners) listener(frame);
			return;
		}

		if (!capabilities.has(frame.sessionId)) return;

		if (frame.type === "session-pending") {
			capabilities.set(frame.newSession.sessionId, frame.newSession.token);
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
			connectionState = "daemon-not-running";
			socket = null;
			scheduleRetry();
			return;
		}
		socket = opened;
		opened.addEventListener("open", handleOpen);
		opened.addEventListener("close", scheduleReconnect);
		opened.addEventListener("message", handleMessage);
		opened.addEventListener("error", handleError);
	}

	return {
		connect(bootstrap: SessionBootstrap): void {
			capabilities.set(bootstrap.sessionId, bootstrap.token);
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

		sendUserMessage(
			sessionId: string,
			body: string,
			opts: SendUserMessageOptions = {},
		): string {
			if (!capabilities.has(sessionId)) {
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
	};
}
