import { randomUUID } from "node:crypto";
import {
	authorizeFrame,
	CHAT_MAX_MANIFEST_BYTES,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	isRecord,
	validateChatFrame,
	validateCommandManifest,
	validateProtoIdentifier,
} from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import type { CliFrame } from "../commands/wire";
import { ManifestLoadError, resolveManifestForPublish } from "../manifest/load";
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

function broadcastPageFrame(
	deps: FrameHandlerDeps,
	sessionId: string,
	frame: Record<string, unknown>,
): Promise<void> {
	const sends: Promise<void>[] = [];
	const payload = JSON.stringify({
		sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...frame,
	});
	deps.connections.forEachCapableOf(sessionId, (socket) => {
		if (socket.data.kind === "ws") sends.push(sendViaQueue(socket, payload));
	});
	return Promise.all(sends).then(() => undefined);
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

function parseCliFrame(value: unknown): CliFrame | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.type) {
		case "cli-recv":
			if (
				typeof value.block === "boolean" &&
				(value.timeoutMs === undefined ||
					(typeof value.timeoutMs === "number" &&
						Number.isFinite(value.timeoutMs) &&
						value.timeoutMs >= 0))
			) {
				return value as CliFrame;
			}
			return undefined;
		case "cli-ack":
			return typeof value.claimId === "string" && value.claimId.length > 0
				? (value as CliFrame)
				: undefined;
		case "cli-send":
			return typeof value.body === "string" ? (value as CliFrame) : undefined;
		case "cli-progress":
			return value.state === "running" || value.state === "awaiting-input"
				? (value as CliFrame)
				: undefined;
		case "cli-manifest-publish":
			try {
				validateCommandManifest(value.commands);
				if (value.subagents !== undefined) {
					if (!Array.isArray(value.subagents)) return undefined;
					value.subagents.forEach((name, index) => {
						validateProtoIdentifier(name, `subagents[${index}]`);
					});
				}
				return value as CliFrame;
			} catch {
				return undefined;
			}
		default:
			return undefined;
	}
}

function cliSessionId(ws: ServerWebSocket<SocketState>): string | undefined {
	return ws.data.kind === "cli"
		? ws.data.capabilities.keys().next().value
		: undefined;
}

function sendCliRecvResult(
	ws: ServerWebSocket<SocketState>,
	result:
		| { outcome: "delivered"; message: Record<string, unknown> }
		| { outcome: "empty" | "timeout" | "closed" },
): Promise<void> {
	return sendViaQueue(
		ws,
		JSON.stringify({ type: "cli-recv-result", ...result }),
	);
}

async function handleCliRecv(
	ws: ServerWebSocket<SocketState>,
	sessionId: string,
	frame: Extract<CliFrame, { type: "cli-recv" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	const first = deps.store.claimNext(sessionId);
	if (first) {
		await sendCliRecvResult(ws, { outcome: "delivered", message: first });
		return;
	}
	if (!frame.block) {
		await sendCliRecvResult(ws, { outcome: "empty" });
		return;
	}

	await new Promise<void>((resolve) => {
		let settled = false;
		const timeoutMs = frame.timeoutMs ?? 30_000;
		const finish = async (
			result:
				| { outcome: "delivered"; message: Record<string, unknown> }
				| { outcome: "timeout" | "closed" },
		) => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			clearTimeout(timeout);
			deps.registry.off("closed", onClosed);
			await sendCliRecvResult(ws, result);
			resolve();
		};
		const onClosed = ({ sessionId: closedId }: { sessionId: string }) => {
			if (closedId === sessionId) void finish({ outcome: "closed" });
		};
		const poll = setInterval(() => {
			const message = deps.store.claimNext(sessionId);
			if (message) void finish({ outcome: "delivered", message });
		}, 20);
		const timeout = setTimeout(
			() => void finish({ outcome: "timeout" }),
			timeoutMs,
		);
		deps.registry.on("closed", onClosed);
		if (deps.registry.get(sessionId)?.state !== "active") {
			void finish({ outcome: "closed" });
		}
	});
}

async function handleCliFrame(
	ws: ServerWebSocket<SocketState>,
	frame: CliFrame,
	deps: FrameHandlerDeps,
): Promise<void> {
	const sessionId = cliSessionId(ws);
	if (!sessionId) {
		await sendError(ws, TRANSPORT_ERROR_SESSION_ID, "cli frame requires /cli");
		noteInvalid(ws);
		return;
	}
	switch (frame.type) {
		case "cli-recv":
			return handleCliRecv(ws, sessionId, frame, deps);
		case "cli-ack":
			deps.store.ack(sessionId, frame.claimId);
			return;
		case "cli-send": {
			const bodyBytes = Buffer.byteLength(frame.body, "utf8");
			if (bodyBytes > CHAT_MAX_MESSAGE_BODY_BYTES) {
				await sendError(
					ws,
					sessionId,
					`cli-send body of ${bodyBytes} bytes exceeds CHAT_MAX_MESSAGE_BODY_BYTES (${CHAT_MAX_MESSAGE_BODY_BYTES})`,
				);
				return;
			}
			deps.store.insertMessage({
				sessionId,
				id: randomUUID(),
				role: "agent",
				body: frame.body,
			});
			await broadcastPageFrame(deps, sessionId, {
				type: "agent-message",
				body: frame.body,
			});
			return;
		}
		case "cli-progress":
			deps.store.insertStatusEvent({
				sessionId,
				state: frame.state,
			});
			await broadcastPageFrame(deps, sessionId, {
				type: "progress",
				state: frame.state,
			});
			return;
		case "cli-manifest-publish": {
			const manifestBytes = Buffer.byteLength(
				JSON.stringify(frame.commands),
				"utf8",
			);
			if (manifestBytes > CHAT_MAX_MANIFEST_BYTES) {
				await sendError(
					ws,
					sessionId,
					`command manifest of ${manifestBytes} bytes exceeds CHAT_MAX_MANIFEST_BYTES (${CHAT_MAX_MANIFEST_BYTES})`,
				);
				return;
			}
			// Publish time means the DAEMON's acceptance of this frame — the CLI's
			// own check is a fast local error only, not the enforcement boundary.
			try {
				resolveManifestForPublish(frame.commands);
			} catch (err) {
				await sendError(
					ws,
					sessionId,
					err instanceof ManifestLoadError ? err.message : String(err),
				);
				return;
			}
			setTimeout(() => {
				void broadcastPageFrame(deps, sessionId, {
					type: "manifest-publish",
					commands: frame.commands,
					...(frame.subagents ? { subagents: frame.subagents } : {}),
				});
			}, 25);
			return;
		}
	}
}

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
			agentIdentity: frame.agentIdentity ?? requester.agentIdentity,
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
	deps: FrameHandlerDeps,
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
	deps.store.insertMessage({
		sessionId: frame.sessionId,
		id: frame.messageId,
		role: "user",
		body: frame.body,
	});
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
			return handleUserMessage(ws, frame, deps);
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

	const cliFrame = parseCliFrame(parsed);
	if (cliFrame) {
		if (ws.data.kind !== "cli") {
			await sendError(
				ws,
				TRANSPORT_ERROR_SESSION_ID,
				"cli-* frames are accepted only on /cli",
			);
			noteInvalid(ws);
			return;
		}
		await handleCliFrame(ws, cliFrame, deps);
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
