import { randomUUID } from "node:crypto";
import {
	authorizeFrame,
	CHAT_MAX_MANIFEST_BYTES,
	CHAT_MAX_MESSAGE_BODY_BYTES,
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	type CliFrame,
	describeError,
	fitHistoryPage,
	isRecord,
	validateChatFrame,
	validateCommandManifest,
	validateProtoIdentifier,
} from "@dg/common";
import {
	type DgPaths,
	ManifestLoadError,
	resolveManifestForPublish,
} from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import {
	ASSET_DIRECTORY_CONFIG_KEY,
	getAssetDirectorySetting,
	setConfiguredAssetDirectory,
	validateAssetDirectory,
} from "../assets/config";
import {
	type DispatchScheduler,
	dispatchCommand,
	resolveSubagentMention,
} from "../dispatch";
import type { SessionRegistry } from "../session/registry";
import type {
	ChatStore,
	ClaimedAgentMessage,
	ClaimedMessage,
	PeekedMessage,
} from "../store";
import type { ConnectionManager } from "./connection";
import {
	onSocketClose,
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
	dispatchScheduler: DispatchScheduler;
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

const TRANSPORT_ERROR_SESSION_ID = "transport-error";

const MIN_PEEKED_MESSAGE_BYTES =
	new TextEncoder().encode(
		JSON.stringify({
			seq: 1,
			id: "a",
			role: "user",
			body: "",
			createdAt: "2024-01-01T00:00:00.000Z",
		} satisfies PeekedMessage),
	).length + 1;

export const HISTORY_TAIL_ROW_LIMIT = Math.ceil(
	CHAT_MAX_PAYLOAD_BYTES / MIN_PEEKED_MESSAGE_BYTES,
);

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
			return typeof value.body === "string" &&
				(value.to === undefined ||
					(typeof value.to === "string" && value.to.trim().length > 0))
				? (value as CliFrame)
				: undefined;
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

function claimForSession(
	deps: FrameHandlerDeps,
	sessionId: string,
): ClaimedMessage | ClaimedAgentMessage | undefined {
	const fromHuman = deps.store.claimNext(sessionId);
	if (fromHuman) return fromHuman;
	const identity = deps.registry.get(sessionId)?.agentIdentity;
	if (!identity) return undefined;
	return deps.store.claimNextAgentMessage(identity, sessionId);
}

async function handleCliRecv(
	ws: ServerWebSocket<SocketState>,
	sessionId: string,
	frame: Extract<CliFrame, { type: "cli-recv" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	const first = claimForSession(deps, sessionId);
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
			offSocketClose();
			await sendCliRecvResult(ws, result);
			resolve();
		};
		const onClosed = ({ sessionId: closedId }: { sessionId: string }) => {
			if (closedId === sessionId) void finish({ outcome: "closed" });
		};
		const offSocketClose = onSocketClose(
			ws,
			() => void finish({ outcome: "closed" }),
		);
		const poll = setInterval(() => {
			const message = claimForSession(deps, sessionId);
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
	deps.registry.touch(sessionId);
	switch (frame.type) {
		case "cli-recv":
			return handleCliRecv(ws, sessionId, frame, deps);
		case "cli-ack": {
			if (deps.store.ack(sessionId, frame.claimId)) return;
			const identity = deps.registry.get(sessionId)?.agentIdentity;
			if (identity) deps.store.ackAgentMessage(identity, frame.claimId);
			return;
		}
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
			if (frame.to !== undefined) {
				const sender = deps.registry.get(sessionId);
				if (!sender) {
					await sendError(
						ws,
						sessionId,
						"cli-send to an agent identity requires a live session",
					);
					return;
				}
				deps.store.insertAgentMessage({
					senderSessionId: sessionId,
					senderIdentity: sender.agentIdentity,
					recipientIdentity: frame.to,
					id: randomUUID(),
					body: frame.body,
				});
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
			deps.store.saveCommandManifest({
				sessionId,
				commands: frame.commands,
				subagentNames: frame.subagents ?? [],
			});
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
	await sendFrame(ws, handshake.sessionId, {
		type: "session-list",
		sessions: deps.registry.list(),
	});
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
}

async function handleHistoryRequest(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "history-request" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	const overhead = new TextEncoder().encode(
		JSON.stringify({
			sessionId: frame.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			type: "history-response",
			messages: [],
		}),
	).length;
	const tail = deps.store.peekTail(frame.sessionId, HISTORY_TAIL_ROW_LIMIT);
	await sendFrame(ws, frame.sessionId, {
		type: "history-response",
		messages: fitHistoryPage(tail, overhead),
	});
}

async function handleConfigFrame(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "config-get" | "config-set" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	if (frame.type === "config-set" && ws.data.kind !== "ws") {
		await sendFrame(ws, frame.sessionId, {
			type: "config-result",
			key: frame.key,
			error: "config-set is accepted only on the extension socket",
		});
		return;
	}

	if (frame.key !== ASSET_DIRECTORY_CONFIG_KEY) {
		await sendFrame(ws, frame.sessionId, {
			type: "config-result",
			key: frame.key,
			error: `unknown config key "${frame.key}"`,
		});
		return;
	}

	if (frame.type === "config-get") {
		await sendFrame(ws, frame.sessionId, {
			type: "config-result",
			key: frame.key,
			value: getAssetDirectorySetting(deps.paths),
		});
		return;
	}

	if (typeof frame.value !== "string" || frame.value.length === 0) {
		await sendFrame(ws, frame.sessionId, {
			type: "config-result",
			key: frame.key,
			error: `${ASSET_DIRECTORY_CONFIG_KEY} value must be a non-empty string`,
		});
		return;
	}

	const validated = validateAssetDirectory(frame.value);
	if (!validated.ok) {
		await sendFrame(ws, frame.sessionId, {
			type: "config-result",
			key: frame.key,
			error: validated.reason,
		});
		return;
	}
	setConfiguredAssetDirectory(deps.paths, validated.value);
	await sendFrame(ws, frame.sessionId, {
		type: "config-result",
		key: frame.key,
		value: validated.value,
	});
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
	const subagentNames = deps.store.getSubagentNames(frame.sessionId) ?? [];
	const subagentName = resolveSubagentMention(frame.body, subagentNames);
	deps.store.insertMessage({
		sessionId: frame.sessionId,
		id: frame.messageId,
		role: "user",
		body: frame.body,
		...(subagentName ? { subagentName } : {}),
	});
	await sendFrame(ws, frame.sessionId, {
		type: "ack",
		messageId: frame.messageId,
	});
}

async function handleCommandInvocation(
	ws: ServerWebSocket<SocketState>,
	frame: Extract<ChatFrame, { type: "command-invocation" }>,
	deps: FrameHandlerDeps,
): Promise<void> {
	const result = await dispatchCommand(
		frame.sessionId,
		frame.commandLabel,
		frame.params,
		{
			store: deps.store,
			registry: deps.registry,
			scheduler: deps.dispatchScheduler,
		},
	);
	await sendFrame(ws, frame.sessionId, { type: "command-result", ...result });
}

async function dispatchFrame(
	ws: ServerWebSocket<SocketState>,
	frame: ChatFrame,
	deps: FrameHandlerDeps,
): Promise<void> {
	deps.registry.touch(frame.sessionId);
	switch (frame.type) {
		case "user-message":
			return handleUserMessage(ws, frame, deps);
		case "session-create":
			return handleSessionCreate(ws, frame, deps);
		case "session-close":
			return handleSessionClose(ws, frame, deps);
		case "keepalive":
			deps.noteActivity();
			return;
		case "history-request":
			return handleHistoryRequest(ws, frame, deps);
		case "config-get":
		case "config-set":
			return handleConfigFrame(ws, frame, deps);
		case "command-invocation":
			return handleCommandInvocation(ws, frame, deps);
		default:
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
	const rawSessionId = parsedSessionId || TRANSPORT_ERROR_SESSION_ID;

	let frame: ChatFrame;
	try {
		frame = validateChatFrame(parsed);
	} catch (err) {
		await sendError(ws, rawSessionId, describeError(err));
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
		await sendError(ws, frame.sessionId, describeError(err));
		noteInvalid(ws);
		return;
	}

	await dispatchFrame(ws, frame, deps);
}
