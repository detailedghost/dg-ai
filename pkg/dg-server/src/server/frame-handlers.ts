import {
	authorizeFrame,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	validateChatFrame,
} from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import type { SessionRegistry } from "../session/registry";
import type { ChatStore } from "../store";
import type { ConnectionManager } from "./connection";
import {
	registerInvalidFrame,
	type SocketState,
	sendViaQueue,
} from "./connection";
import type { Logger } from "./log";
import { pinOriginIfUnset } from "./origin";

export type FrameHandlerDeps = {
	registry: SessionRegistry;
	connections: ConnectionManager;
	logger: Logger;
	paths: DgPaths;
	noteActivity: () => void;
	store: ChatStore;
};

function sendFrame(
	ws: ServerWebSocket<SocketState>,
	sessionId: string,
	frame: Record<string, unknown>,
): Promise<void> {
	return sendViaQueue(
		ws,
		JSON.stringify({
			sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			...frame,
		}),
	);
}

function sendError(
	ws: ServerWebSocket<SocketState>,
	sessionId: string,
	message: string,
): Promise<void> {
	return sendFrame(ws, sessionId, { type: "error", message });
}

// validateChatFrame requires a non-empty sessionId on every frame, including
// outbound "error" — used when the failing frame carried no real one to echo.
const TRANSPORT_ERROR_SESSION_ID = "transport-error";

/** Closes the socket once the small failed-frame budget is exceeded. */
function noteInvalid(ws: ServerWebSocket<SocketState>): void {
	if (registerInvalidFrame(ws.data)) {
		ws.close(1008, "invalid frame budget exceeded");
	}
}

type ConnectHandshake = {
	type: "connect";
	sessionId: string;
	token: string;
	protocolVersion: number;
};

/**
 * "connect" is deliberately outside the 18 ratified ChatFrame types (they all
 * assume capability already exists) — it is the /ws capability-capture
 * handshake, checked structurally here rather than through validateChatFrame.
 */
function isConnectHandshake(value: unknown): value is ConnectHandshake {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.type === "connect" &&
		typeof record.sessionId === "string" &&
		typeof record.token === "string" &&
		typeof record.protocolVersion === "number"
	);
}

async function handleConnectHandshake(
	ws: ServerWebSocket<SocketState>,
	handshake: ConnectHandshake,
	deps: FrameHandlerDeps,
): Promise<void> {
	if (handshake.protocolVersion !== CHAT_PROTOCOL_VERSION) {
		await sendError(
			ws,
			handshake.sessionId,
			`protocol version mismatch: daemon expects ${CHAT_PROTOCOL_VERSION}, frame declared ${handshake.protocolVersion}`,
		);
		noteInvalid(ws);
		return;
	}
	if (!deps.registry.validate(handshake.sessionId, handshake.token)) {
		await sendError(
			ws,
			handshake.sessionId,
			"connect handshake presented an invalid or closed session capability",
		);
		noteInvalid(ws);
		return;
	}
	ws.data.capabilities.set(handshake.sessionId, handshake.token);
	deps.noteActivity();
	// A page connecting after sessions already exist otherwise learns of none —
	// session-list is outbound-only, so it has no other way to ask.
	await sendFrame(ws, handshake.sessionId, {
		type: "session-list",
		sessions: deps.registry.list(),
	});
	// TOFU commit point: only a token-proven connection pins the origin, so a
	// merely well-shaped fake Origin can never pin anything on its own.
	if (ws.data.kind === "ws" && ws.data.originHeader) {
		pinOriginIfUnset(deps.paths, ws.data.originHeader);
	}
}

async function handleSessionCreate(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "session-create" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	const requester = deps.registry.get(frame.sessionId);
	if (!requester) {
		// Unreachable today (authorizeFrame already matched this pair against the
		// socket's capability map) — never fall back to the daemon's own cwd.
		await sendError(ws, frame.sessionId, "session-create: requester unknown");
		return;
	}
	let record: ReturnType<typeof deps.registry.create>;
	try {
		record = deps.registry.create({
			cwd: requester.cwd,
			agentIdentity: requester.agentIdentity,
			workset: frame.workset,
			role: frame.role,
		});
	} catch {
		await sendError(
			ws,
			frame.sessionId,
			"session-create: cwd does not resolve",
		);
		return;
	}
	ws.data.capabilities.set(record.sessionId, record.token);
	deps.noteActivity();
	await sendFrame(ws, frame.sessionId, {
		type: "session-pending",
		newSession: { sessionId: record.sessionId, token: record.token },
	});
	// Session-list broadcasting is centralized on registry's "changed" event
	// (wired once in bootstrap.ts) — registry.create() above already fired it.
}

async function handleSessionClose(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "session-close" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	const closed = deps.registry.close(
		frame.sessionId,
		ws.data.kind === "cli" ? "cli" : "canvas",
	);
	if (!closed) {
		await sendError(
			ws,
			frame.sessionId,
			"session is already closed or unknown",
		);
		return;
	}
	// Broadcast + capability revocation happens in the single registry "closed"
	// listener wired at bootstrap — reused by shutdown and every closer above.
}

async function handleHistoryRequest(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "history-request" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	// Stored-record projection (seq, id, role, body, createdAt, attachmentId?),
	// ordered by seq ascending — the cross-slice history-response contract.
	await sendFrame(ws, frame.sessionId, {
		type: "history-response",
		messages: deps.store.peekAll(frame.sessionId),
	});
}

async function handleConfigFrame(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "config-get" | "config-set" }>,
): Promise<void> {
	// config-set is inbound-only (validateChatFrame requires a token), so it
	// can't double as this reply. Real transport lands in slice 9 (outside src/server/**).
	await sendError(
		ws,
		frame.sessionId,
		"daemon config transport is not implemented yet (lands in slice 9)",
	);
}

async function handleUserMessage(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "user-message" }>,
): Promise<void> {
	const bodyBytes = Buffer.byteLength(frame.body, "utf8");
	if (bodyBytes > CHAT_MAX_MESSAGE_BODY_BYTES) {
		await sendError(
			ws,
			frame.sessionId,
			`user-message body of ${bodyBytes} bytes exceeds CHAT_MAX_MESSAGE_BODY_BYTES (${CHAT_MAX_MESSAGE_BODY_BYTES})`,
		);
		return;
	}
	// deps.store exists now; user-message persistence is slice 7/8's dispatch
	// wiring — ack-without-persistence stays the honest placeholder here.
	await sendFrame(ws, frame.sessionId, {
		type: "ack",
		messageId: frame.messageId,
	});
}

async function dispatchFrame(
	ws: ServerWebSocket<SocketState>,
	frame: ChatFrame,
	deps: FrameHandlerDeps,
): Promise<void> {
	switch (frame.type) {
		case "user-message":
			return handleUserMessage(ws, frame);
		case "session-create":
			return handleSessionCreate(ws, frame, deps);
		case "session-close":
			return handleSessionClose(ws, frame, deps);
		case "keepalive":
			// Liveness only. Replying would double the traffic the keepalive minimises.
			deps.noteActivity();
			return;
		case "history-request":
			return handleHistoryRequest(ws, frame, deps);
		case "config-get":
		case "config-set":
			return handleConfigFrame(ws, frame);
		case "command-invocation":
			// Slice 8 owns $ dispatch (src/dispatch/**, also outside src/server/**).
			await sendError(
				ws,
				frame.sessionId,
				"$ command dispatch is not implemented yet (lands in slice 8)",
			);
			return;
		default:
			// Every other type is outbound-only, so authorizeFrame already rejected
			// it upstream — an unreachable defensive fallback, not an assertNever crash.
			await sendError(
				ws,
				frame.sessionId,
				`frame type "${frame.type}" is not actionable inbound`,
			);
	}
}

export async function handleSocketMessage(
	ws: ServerWebSocket<SocketState>,
	raw: string | Buffer,
	deps: FrameHandlerDeps,
): Promise<void> {
	const bytes =
		typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
	if (bytes > CHAT_MAX_PAYLOAD_BYTES) {
		// Rejected before parsing (no sessionId yet, no store side effect) —
		// still a distinct, observable error frame, not a silent drop.
		await sendError(
			ws,
			TRANSPORT_ERROR_SESSION_ID,
			`payload of ${bytes} bytes exceeds CHAT_MAX_PAYLOAD_BYTES (${CHAT_MAX_PAYLOAD_BYTES})`,
		);
		noteInvalid(ws);
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
	} catch {
		noteInvalid(ws);
		return;
	}

	if (isConnectHandshake(parsed)) {
		await handleConnectHandshake(ws, parsed, deps);
		return;
	}

	const parsedSessionId =
		typeof parsed === "object" &&
		parsed !== null &&
		typeof (parsed as Record<string, unknown>).sessionId === "string"
			? ((parsed as Record<string, unknown>).sessionId as string)
			: "";
	// validateChatFrame requires a non-empty sessionId, so a missing/blank one
	// still needs a placeholder to make the schema-failure error deliverable.
	const rawSessionId = parsedSessionId || TRANSPORT_ERROR_SESSION_ID;

	let frame: ChatFrame;
	try {
		frame = validateChatFrame(parsed);
	} catch (err) {
		await sendError(
			ws,
			rawSessionId,
			err instanceof Error ? err.message : String(err),
		);
		noteInvalid(ws);
		return;
	}

	if (frame.protocolVersion !== CHAT_PROTOCOL_VERSION) {
		await sendError(
			ws,
			frame.sessionId,
			`protocol version mismatch: daemon expects ${CHAT_PROTOCOL_VERSION}, frame declared ${frame.protocolVersion}`,
		);
		noteInvalid(ws);
		return;
	}

	try {
		authorizeFrame(frame, ws.data.capabilities);
	} catch (err) {
		await sendError(
			ws,
			frame.sessionId,
			err instanceof Error ? err.message : String(err),
		);
		noteInvalid(ws);
		return;
	}

	await dispatchFrame(ws, frame, deps);
}
