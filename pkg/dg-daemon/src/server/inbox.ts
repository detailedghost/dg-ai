import {
	authorizeFrame,
	CHAT_PROTOCOL_VERSION,
	INBOX_DEFAULT_TIMEOUT_MS,
	type ChatFrame,
	type InboxCliRequest,
	validateInboxBrowserResponse,
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
type Result = { ok: true; value: unknown } | { ok: false; error: string };
type RelayOperation = "browser" | "send-approval";
type Pending = {
	sessionId: string;
	operation: RelayOperation;
	requester: Socket;
	extension: Socket;
	finish: (result: Result, deliver?: boolean) => void;
};
type RelayState = {
	pending: Map<string, Pending>;
	seen: Map<string, Set<string>>;
};
const states = new WeakMap<ConnectionManager, RelayState>();
const MAX_SESSION_REQUEST_IDS = 10_000;
const MAX_PENDING = 128;
const MAX_REQUESTER_PENDING = 8;
const BROWSER_MIN_VERSION = { major: 1, minor: 11 } as const;
const SEND_APPROVAL_MIN_VERSION = { major: 1, minor: 22 } as const;

function state(deps: FrameHandlerDeps): RelayState {
	let existing = states.get(deps.connections);
	if (!existing) {
		existing = { pending: new Map(), seen: new Map() };
		states.set(deps.connections, existing);
		const owned = existing;
		deps.registry.on("closed", ({ sessionId }: { sessionId: string }) => {
			owned.seen.delete(sessionId);
			for (const pending of owned.pending.values()) {
				if (pending.sessionId === sessionId)
					pending.finish({
						ok: false,
						error: "Inbox session closed before the extension replied.",
					});
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
			type: "cli-inbox-result",
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
		`No extension peer on session ${sessionId}. Connect the dg extension to session ${sessionId} and open an authenticated Proton Mail tab. ` +
		`Open ${hint} in the browser where the extension is loaded, then reload the Proton Mail tab. ` +
		"Inbox requires dg extension 1.11.0 or newer."
	);
}

function satisfiesVersion(
	raw: string | undefined,
	floor: { major: number; minor: number },
): boolean {
	const version = raw?.match(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
	);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = Number(version[2]);
	return major > floor.major || (major === floor.major && minor >= floor.minor);
}

/** Handles authenticated profile/cache requests or binds a browser relay to one requester and one authorized extension. */
export async function handleInboxCli(
	requester: Socket,
	sessionId: string,
	frame: InboxCliRequest,
	deps: FrameHandlerDeps,
): Promise<void> {
	if (deps.registry.get(sessionId)?.state !== "active") {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error: "Inbox requires an active dg session.",
		});
		return;
	}
	if (frame.operation !== "browser" && frame.operation !== "send-approval") {
		try {
			let value: unknown = null;
			switch (frame.operation) {
				case "profile-get":
					value = deps.store.getInboxProfile(frame.name!);
					break;
				case "profile-set":
					deps.store.setInboxProfile(frame.name!, frame.profile);
					break;
				case "profile-list":
					value = deps.store.listInboxProfiles();
					break;
				case "cache-get":
					value = deps.store.getInboxAuthCache(frame.name!, frame.provider!);
					break;
				case "cache-set":
					deps.store.setInboxAuthCache(
						frame.name!,
						frame.provider!,
						frame.cache,
					);
					break;
			}
			await result(requester, sessionId, frame.requestId, { ok: true, value });
		} catch {
			await result(requester, sessionId, frame.requestId, {
				ok: false,
				error:
					"Inbox configuration storage failed; check daemon health and encryption key access.",
			});
		}
		return;
	}
	const isSendApproval = frame.operation === "send-approval";
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
				"Inbox has too many pending requests from this client; wait for existing work to finish.",
		});
		return;
	}
	const seen = relay.seen.get(sessionId) ?? new Set<string>();
	relay.seen.set(sessionId, seen);
	if (seen.has(frame.requestId)) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error: "Inbox requestId was already used; create a new requestId.",
		});
		return;
	}
	if (
		seen.size >= MAX_SESSION_REQUEST_IDS ||
		relay.pending.size >= MAX_PENDING
	) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error:
				"Inbox request capacity reached; finish pending work or start a new session.",
		});
		return;
	}
	seen.add(frame.requestId);
	const peers: Socket[] = [];
	deps.connections.forEachCapableOf(sessionId, (socket) => {
		if (socket.data.kind === "ws") peers.push(socket);
	});
	if (peers.length !== 1) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error: peers.length
				? "Multiple extension peers make the inbox request ambiguous; keep one extension connected to this session."
				: isSendApproval
					? `Send approval needs the human's dg chat tab. ${missingExtensionError(sessionId, deps)}`
					: missingExtensionError(sessionId, deps),
		});
		return;
	}
	const extension = peers[0];
	const minVersion = isSendApproval
		? SEND_APPROVAL_MIN_VERSION
		: BROWSER_MIN_VERSION;
	if (!satisfiesVersion(extension.data.extensionVersion, minVersion)) {
		await result(requester, sessionId, frame.requestId, {
			ok: false,
			error: isSendApproval
				? "Send approval requires dg extension 1.22.0 or newer; update the extension, reload it, and reconnect this session."
				: "Inbox requires dg extension 1.11.0 or newer; update the extension, reload it, and reconnect this session.",
		});
		return;
	}
	let settled = false;
	let offRequester = () => {};
	let offExtension = () => {};
	const finish = (answer: Result, deliver = true) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		offRequester();
		offExtension();
		relay.pending.delete(requestKey);
		if (deliver)
			void result(requester, sessionId, frame.requestId, answer).catch(
				() => {},
			);
	};
	const timeout = setTimeout(
		() =>
			finish({
				ok: false,
				error: isSendApproval
					? "Send approval timed out; the human did not decide within the wait."
					: "Inbox extension request timed out; check the authenticated Proton tab and retry with a new requestId.",
			}),
		frame.timeoutMs ?? INBOX_DEFAULT_TIMEOUT_MS,
	);
	const pending: Pending = {
		sessionId,
		operation: frame.operation,
		requester,
		extension,
		finish,
	};
	relay.pending.set(requestKey, pending);
	offRequester = onSocketClose(requester, () =>
		finish({ ok: false, error: "Inbox requester disconnected." }, false),
	);
	offExtension = onSocketClose(extension, () =>
		finish({
			ok: false,
			error: "Inbox extension disconnected before replying.",
		}),
	);
	const outbound = isSendApproval
		? {
				type: "inbox-send-approval-request",
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: frame.requestId,
				approval: frame.approval,
			}
		: {
				type: "inbox-browser-request",
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: frame.requestId,
				request: frame.request,
			};
	try {
		await sendViaQueue(extension, JSON.stringify(outbound));
	} catch {
		finish({
			ok: false,
			error: isSendApproval
				? "Send approval request could not be sent; reconnect the extension."
				: "Inbox extension request could not be sent; reconnect the extension.",
		});
	}
}

/** Settles only the pending session/request owned by this extension socket; late or duplicate replies are ignored. */
export function handleInboxBrowserResult(
	socket: Socket,
	frame: Extract<ChatFrame, { type: "inbox-browser-result" }>,
	deps: FrameHandlerDeps,
): void {
	const pending = state(deps).pending.get(
		key(frame.sessionId, frame.requestId),
	);
	if (
		!pending ||
		pending.operation !== "browser" ||
		pending.extension !== socket ||
		socket.data.kind !== "ws"
	)
		return;
	if (!frame.ok) {
		pending.finish({ ok: false, error: frame.error! });
		return;
	}
	pending.finish({ ok: true, value: validateInboxBrowserResponse(frame.data) });
}

/** Settles a pending send-approval only for the authorized extension socket holding it; a CLI socket is always refused. */
export function handleInboxSendApprovalResult(
	socket: Socket,
	frame: Extract<ChatFrame, { type: "inbox-send-approval-result" }>,
	deps: FrameHandlerDeps,
): void {
	if (socket.data.kind !== "ws") return;
	try {
		authorizeFrame(frame, socket.data.capabilities);
	} catch {
		return;
	}
	const pending = state(deps).pending.get(
		key(frame.sessionId, frame.requestId),
	);
	if (
		!pending ||
		pending.operation !== "send-approval" ||
		pending.extension !== socket
	)
		return;
	pending.finish({
		ok: true,
		value: { approved: frame.approved, decidedAt: new Date().toISOString() },
	});
}
