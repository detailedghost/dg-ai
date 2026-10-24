import {
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	type ProtoCliRequest,
} from "@dg/common";
import type { ServerWebSocket } from "bun";
import type { FrameHandlerDeps } from "./frame-handlers";
import { readPidFile } from "@dg/common/node";
import {
	onSocketClose,
	sendViaQueue,
	type ConnectionManager,
	type SocketState,
} from "./connection";

type Socket = ServerWebSocket<SocketState>;
type Result =
	| { ok: true; data: unknown }
	| { ok: false; notReady: unknown; error?: never }
	| { ok: false; error: string; notReady?: never };
type Pending = {
	sessionId: string;
	requester: Socket;
	extension: Socket;
	lastStatus?: string;
	finish: (result: Result, deliver?: boolean) => void;
};
type RelayState = { pending: Map<string, Pending> };
const states = new WeakMap<ConnectionManager, RelayState>();
const MAX_PENDING = 32;
const MAX_REQUESTER_PENDING = 4;

const PROTO_DEFAULT_TIMEOUT_MS: Record<ProtoCliRequest["phase"], number> = {
	scrape: 45_000,
	plant: 900_000,
};

function state(deps: FrameHandlerDeps): RelayState {
	let existing = states.get(deps.connections);
	if (!existing) {
		existing = { pending: new Map() };
		states.set(deps.connections, existing);
		const owned = existing;
		deps.registry.on("closed", ({ sessionId }: { sessionId: string }) => {
			for (const pending of owned.pending.values()) {
				if (pending.sessionId === sessionId) {
					pending.finish({
						ok: false,
						error: "Prototype session closed before the extension replied.",
					});
				}
			}
		});
	}
	return existing;
}

function key(sessionId: string, requestId: string): string {
	return JSON.stringify([sessionId, requestId]);
}

function result(
	requester: Socket,
	sessionId: string,
	requestId: string,
	answer: Result,
): Promise<void> {
	return sendViaQueue(
		requester,
		JSON.stringify({
			type: "cli-proto-result",
			sessionId,
			requestId,
			...answer,
		}),
	);
}

function missingExtensionError(
	sessionId: string,
	deps: FrameHandlerDeps,
): string {
	const port = readPidFile(deps.paths)?.port;
	const hint = port
		? `http://127.0.0.1:${port}/start#_chat=<base64url JSON of port, sessionId, token, and agentIdentity>`
		: "http://127.0.0.1:<port>/start#_chat=<base64url JSON of port, sessionId, token, and agentIdentity>";
	return (
		`No extension peer on session ${sessionId}. Connect the dg extension to session ${sessionId}. ` +
		`Open ${hint} in the browser where the extension is loaded, then retry. ` +
		`Run dg-skills inbox bootstrap-url --session ${sessionId} to print the real URL (that pairing is shared across every daemon feature, not just inbox).`
	);
}

/** Relays one `--ext` scrape/plant request to the session's sole paired extension and waits for its result. */
export async function handleProtoCli(
	requester: Socket,
	sessionId: string,
	frame: ProtoCliRequest,
	deps: FrameHandlerDeps,
): Promise<void> {
	if (deps.registry.get(sessionId)?.state !== "active") {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error: "Prototype --ext requires an active dg session.",
		});
		return;
	}
	const relay = state(deps);
	const requestKey = key(sessionId, frame.requestId);
	if (relay.pending.get(requestKey)?.requester === requester) return;
	let requesterPending = 0;
	for (const pending of relay.pending.values()) {
		if (pending.requester === requester) requesterPending++;
	}
	if (requesterPending >= MAX_REQUESTER_PENDING) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error:
				"Prototype has too many pending requests from this client; wait for existing work to finish.",
		});
		return;
	}
	if (relay.pending.size >= MAX_PENDING) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error:
				"Prototype request capacity reached; finish pending work or start a new session.",
		});
		return;
	}
	const peers: Socket[] = [];
	deps.connections.forEachCapableOf(sessionId, (socket) => {
		if (socket.data.kind === "ws") peers.push(socket);
	});
	if (peers.length !== 1) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error: peers.length
				? "Multiple extension peers make the prototype request ambiguous; keep one extension connected to this session."
				: missingExtensionError(sessionId, deps),
		});
		return;
	}
	const extension = peers[0];

	let settled = false;
	let offRequester = () => {};
	let offExtension = () => {};
	const pending: Pending = {
		sessionId,
		requester,
		extension,
		finish: (answer, deliver = true) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			offRequester();
			offExtension();
			relay.pending.delete(requestKey);
			if (deliver) {
				void result(requester, sessionId, frame.requestId, answer).catch(
					() => {},
				);
			}
		},
	};
	const timeoutMs = frame.timeoutMs ?? PROTO_DEFAULT_TIMEOUT_MS[frame.phase];
	const timeout = setTimeout(() => {
		pending.finish({
			ok: false,
			error: pending.lastStatus
				? `Prototype ${frame.phase} timed out after ${timeoutMs}ms; last report from the extension: ${pending.lastStatus}.`
				: `Prototype ${frame.phase} timed out after ${timeoutMs}ms with no report from the extension. It may not have loaded ${frame.markedUrl} in a paired browser, or it predates this change; rebuild and reload the unpacked extension and retry.`,
		});
	}, timeoutMs);
	relay.pending.set(requestKey, pending);
	offRequester = onSocketClose(requester, () =>
		pending.finish(
			{ ok: false, error: "Prototype requester disconnected." },
			false,
		),
	);
	offExtension = onSocketClose(extension, () =>
		pending.finish({
			ok: false,
			error: "Prototype extension disconnected before replying.",
		}),
	);
	try {
		await sendViaQueue(
			extension,
			JSON.stringify({
				type: "proto-browser-request",
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: frame.requestId,
				phase: frame.phase,
				slug: frame.slug,
				markedUrl: frame.markedUrl,
			}),
		);
	} catch {
		pending.finish({
			ok: false,
			error:
				"Prototype extension request could not be sent; reconnect the extension.",
		});
	}
}

/** Settles only the pending session/request owned by this extension socket; late or duplicate replies are ignored. */
export function handleProtoBrowserResult(
	socket: Socket,
	frame: Extract<ChatFrame, { type: "proto-browser-result" }>,
	deps: FrameHandlerDeps,
): void {
	const pending = state(deps).pending.get(
		key(frame.sessionId, frame.requestId),
	);
	if (!pending || pending.extension !== socket || socket.data.kind !== "ws") {
		return;
	}
	if (!frame.ok) {
		pending.finish(
			frame.notReady
				? { ok: false, notReady: frame.notReady }
				: { ok: false, error: frame.error! },
		);
		return;
	}
	pending.finish({ ok: true, data: frame.data });
}

/** Records the extension's last-seen status for this pending request without settling it. */
export function handleProtoBrowserProgress(
	socket: Socket,
	frame: Extract<ChatFrame, { type: "proto-browser-progress" }>,
	deps: FrameHandlerDeps,
): void {
	const pending = state(deps).pending.get(
		key(frame.sessionId, frame.requestId),
	);
	if (!pending || pending.extension !== socket || socket.data.kind !== "ws") {
		return;
	}
	pending.lastStatus = frame.status;
}
