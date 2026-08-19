/**
 * The headless chat client: one socket shared across every captured session's
 * capability, inbound demux against that capability set, jittered exponential
 * backoff on reconnect, and an outbox that delivers disconnected-composed
 * messages exactly once. Module surface ratified in plan.md's Code Structure
 * ("Layer-2 module surface ratifications", slice 5).
 */

import {
	CHAT_DEFAULT_PORT,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_PORT_FALLBACK_COUNT,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	createSerialQueue,
	type SessionBootstrap,
	type SessionRole,
	validateChatFrame,
} from "@dg/common";

/** The one socket-shape type for the extension — lib/background/chat.ts reuses this rather than redeclaring it. */
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

/** GET /health's shape, per plan.md's transport ratification — `daemon` is the service name, not a boolean. */
export type ChatHealth = { daemon: "dg-server"; instanceId: string };

/** Ratified verbatim in plan.md's Layer-2 module surface ratifications — exactly these 4 fields. */
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

/** The pre-capability handshake object — the one frame type outside the ratified ChatFrame union. */
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

/** Real GET /health probe; swallows every failure since an unreachable port is the expected steady state during rediscovery. */
async function defaultFetchHealth(
	port: number,
): Promise<ChatHealth | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		if (!res.ok) return undefined;
		const body = (await res.json()) as {
			daemon?: unknown;
			instanceId?: unknown;
		};
		if (body.daemon !== "dg-server" || typeof body.instanceId !== "string") {
			return undefined;
		}
		return { daemon: "dg-server", instanceId: body.instanceId };
	} catch {
		return undefined;
	}
}

/**
 * Scans the default port plus its fallback range for a live dg-server,
 * preferring one matching `preferInstanceId` over any other.
 */
async function findDaemonPort(
	preferInstanceId?: string,
): Promise<number | undefined> {
	let fallback: number | undefined;
	for (
		let candidate = CHAT_DEFAULT_PORT;
		candidate <= CHAT_DEFAULT_PORT + CHAT_PORT_FALLBACK_COUNT;
		candidate++
	) {
		const health = await defaultFetchHealth(candidate);
		if (!health || health.daemon !== "dg-server") continue;
		if (
			preferInstanceId !== undefined &&
			health.instanceId === preferInstanceId
		) {
			return candidate;
		}
		if (fallback === undefined) fallback = candidate;
	}
	return fallback;
}

type QueuedMessage = {
	sessionId: string;
	messageId: string;
	body: string;
	subagentName?: string;
};

/** Kept out of the socket-owning module's typed surface; the transcript view types its own record. */
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
	// Set on the first connect() call and never reset — guards against a second,
	// un-backed-off attempt after a throw nulls `socket` (see openAndBind's catch).
	let hasAttemptInFlight = false;
	// The one live retry timer — scheduleRetry clears it before storing a new
	// one, so a superseded retry can never open a second live socket.
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	// Bumped per openAndBind attempt, so a send still queued for a prior
	// socket can tell it's stale once reconnect re-enqueues the same message.
	let socketGeneration = 0;
	// True once "open" has fired at least once — lets scheduleRetry tell a
	// cached port that was always wrong from one merely missing an instanceId.
	let everConnected = false;
	// Learned from /health on every successful open, for rediscoverPort to match against.
	let knownInstanceId: string | undefined;
	const capabilities = new Map<string, string>();
	const frameListeners = new Set<(frame: ChatFrame) => void>();
	const outbox: QueuedMessage[] = [];
	// Ratified "Outbound frame ordering" decision: one createSerialQueue per socket.
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
			// An ack can prune this from the outbox, or reconnect can re-enqueue it
			// for a newer socket, while this attempt still sits queued behind a slow send.
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
			// Re-learn on every open, not just the first — dg-server mints a fresh
			// instanceId per restart, so a stale cached id would never match again.
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

	/** Backoff bookkeeping shared by every retry path, kept apart from connectionState so a post-throw retry doesn't overwrite "daemon-not-running". */
	function scheduleRetry(): void {
		const raw = Math.min(backoffBaseMs * 2 ** reconnectAttempt, backoffMaxMs);
		const delay = Math.min(raw * (1 + randomJitter()), backoffMaxMs);
		reconnectAttempt += 1;
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			// Retry the cached port directly once connected but instanceId-less;
			// otherwise scan (also covers a port that was never reachable at all).
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
		// A close event (real or test-driven) still does the state-setting and
		// retry scheduling; this just keeps state correct if error fires alone.
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
		// session-list is roster-wide and tokenless — the envelope sessionId names
		// whichever session changed, not the receiving page's own capability set.
		if (frame.type === "session-list") {
			for (const listener of frameListeners) listener(frame);
			return;
		}

		if (!capabilities.has(frame.sessionId)) return;

		if (frame.type === "session-pending") {
			// The daemon's session-create response grants the new capability here.
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
			// Keep retrying, or a throw mid-retry strands the client with no timer.
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
			// Reject oversized bodies here, before queueing — the daemon refuses them
			// with no ack, and flushOutbox would otherwise resend one forever.
			const bodyBytes = new TextEncoder().encode(body).length;
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
