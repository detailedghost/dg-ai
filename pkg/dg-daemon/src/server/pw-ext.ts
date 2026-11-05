import {
	authorizeFrame,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	describeError,
	isRecord,
	PW_EXT_DEFAULT_TIMEOUT_MS,
	PW_EXT_MIN_EXTENSION_VERSION,
	type PwExtCliRequest,
	type PwExtResponse,
	validateChatFrame,
} from "@dg/common";
import type { ServerWebSocket } from "bun";
import type { FrameHandlerDeps } from "./frame-handlers";
import {
	isExtensionPeer,
	onSocketClose,
	sendViaQueue,
	type ConnectionManager,
	type SocketState,
} from "./connection";

type Socket = ServerWebSocket<SocketState>;
type Result = { ok: true; data: PwExtResponse } | { ok: false; error: string };
type Pending = {
	sessionId: string;
	requester: Socket;
	extension: Socket;
	finish: (result: Result, deliver?: boolean) => void;
};
type RelayState = { pending: Map<string, Pending>; used: Map<string, Set<string>> };
const states = new WeakMap<ConnectionManager, RelayState>();
const MAX_SESSION_REQUEST_IDS = 10_000;
const MAX_PENDING = 16;
const MAX_REQUESTER_PENDING = 2;
const MIN_VERSION = PW_EXT_MIN_EXTENSION_VERSION.join(".");

function relayState(deps: FrameHandlerDeps): RelayState {
	let existing = states.get(deps.connections);
	if (!existing) {
		const owned: RelayState = { pending: new Map(), used: new Map() };
		existing = owned;
		states.set(deps.connections, owned);
		deps.registry.on("closed", ({ sessionId }: { sessionId: string }) => {
			owned.used.delete(sessionId);
			for (const pending of owned.pending.values())
				if (pending.sessionId === sessionId)
					pending.finish({
						ok: false,
						error: "pw --ext session closed before the extension replied.",
					});
		});
	}
	return existing;
}

function key(sessionId: string, requestId: string): string {
	return JSON.stringify([sessionId, requestId]);
}

/** Sends one correlated result to the CLI that asked. */
export function sendPwExtResult(
	requester: Socket,
	sessionId: string,
	requestId: string,
	answer: Result,
): Promise<void> {
	return sendViaQueue(
		requester,
		JSON.stringify({ type: "cli-pw-ext-result", sessionId, requestId, ...answer }),
	);
}

function versionAtLeastMinimum(version: string | undefined): boolean {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/);
	if (!match) return false;
	const actual = match.slice(1, 4).map(Number);
	for (let i = 0; i < 3; i++) {
		const want = PW_EXT_MIN_EXTENSION_VERSION[i] as number;
		if ((actual[i] as number) !== want) return (actual[i] as number) > want;
	}
	return true;
}

/** Relays one pw --ext verb to the session's sole paired extension and waits for its reply. */
export async function handlePwExtCli(
	requester: Socket,
	sessionId: string,
	frame: PwExtCliRequest,
	deps: FrameHandlerDeps,
): Promise<void> {
	const fail = (error: string) =>
		sendPwExtResult(requester, sessionId, frame.requestId, { ok: false, error });
	if (deps.registry.get(sessionId)?.state !== "active")
		return fail("pw --ext requires an active dg session.");
	const { pending, used } = relayState(deps);
	const requestKey = key(sessionId, frame.requestId);
	const usedIds = used.get(sessionId) ?? new Set<string>();
	if (usedIds.has(frame.requestId))
		return fail("pw --ext requestId was already used on this session; send a new one.");
	if (usedIds.size >= MAX_SESSION_REQUEST_IDS)
		return fail("pw --ext request capacity reached; start a new session.");
	let mine = 0;
	for (const entry of pending.values()) if (entry.requester === requester) mine++;
	if (mine >= MAX_REQUESTER_PENDING || pending.size >= MAX_PENDING)
		return fail(
			"pw --ext has too many pending requests; wait for the open approval to finish.",
		);
	const peers: Socket[] = [];
	deps.connections.forEachCapableOf(sessionId, (socket) => {
		if (isExtensionPeer(socket)) peers.push(socket);
	});
	if (peers.length !== 1)
		return fail(
			peers.length
				? "Multiple extension peers make the pw --ext request ambiguous; keep one extension connected to this session."
				: `No extension peer on session ${sessionId}. Pair the dg-ai-extension with this session, then retry. Run dg-skills doctor pw for the steps.`,
		);
	const extension = peers[0] as Socket;
	usedIds.add(frame.requestId);
	used.set(sessionId, usedIds);
	if (!versionAtLeastMinimum(extension.data.extensionVersion))
		return fail(
			`pw --ext requires dg-ai-extension ${MIN_VERSION} or newer; update the extension, reload it, and reconnect this session.`,
		);

	let settled = false;
	let offRequester = () => {};
	let offExtension = () => {};
	const timeoutMs = frame.timeoutMs ?? PW_EXT_DEFAULT_TIMEOUT_MS;
	const entry: Pending = {
		sessionId,
		requester,
		extension,
		finish: (answer, deliver = true) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			offRequester();
			offExtension();
			pending.delete(requestKey);
			if (deliver)
				void sendPwExtResult(requester, sessionId, frame.requestId, answer).catch(
					() => {},
				);
		},
	};
	const timeout = setTimeout(
		() =>
			entry.finish({
				ok: false,
				error: `pw --ext timed out after ${timeoutMs}ms. The approval may still be open in the browser; deny it there, then retry.`,
			}),
		timeoutMs,
	);
	pending.set(requestKey, entry);
	offRequester = onSocketClose(requester, () =>
		entry.finish({ ok: false, error: "pw --ext requester disconnected." }, false),
	);
	offExtension = onSocketClose(extension, () =>
		entry.finish({
			ok: false,
			error: "pw --ext extension disconnected before replying.",
		}),
	);
	try {
		await sendViaQueue(
			extension,
			JSON.stringify({
				type: "pw-ext-browser-request",
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: frame.requestId,
				request: frame.request,
				timeoutMs,
			}),
		);
	} catch {
		entry.finish({
			ok: false,
			error: "pw --ext request could not be sent; reconnect the extension.",
		});
	}
}

/** Settles only the pending request this extension socket owns; late or foreign replies are ignored. */
export function handlePwExtBrowserResult(
	socket: Socket,
	frame: Extract<ChatFrame, { type: "pw-ext-browser-result" }>,
	deps: FrameHandlerDeps,
): void {
	const entry = relayState(deps).pending.get(key(frame.sessionId, frame.requestId));
	if (!entry || entry.extension !== socket || !isExtensionPeer(socket)) return;
	entry.finish(
		frame.ok
			? { ok: true, data: frame.data as PwExtResponse }
			: { ok: false, error: frame.error as string },
	);
}

/** Fails the request an unreadable or oversized result names; false when it names none. */
export function settleRejectedPwExtResult(
	socket: Socket,
	raw: unknown,
	deps: FrameHandlerDeps,
	reason?: string,
): boolean {
	if (!isRecord(raw) || raw.type !== "pw-ext-browser-result") return false;
	if (!isExtensionPeer(socket)) return false;
	const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
	const requestId = typeof raw.requestId === "string" ? raw.requestId : "";
	const entry = relayState(deps).pending.get(key(sessionId, requestId));
	if (!entry || entry.extension !== socket) return false;
	try {
		authorizeFrame(
			{ type: "pw-ext-browser-result", sessionId, token: raw.token },
			socket.data.capabilities,
		);
	} catch {
		return false;
	}
	let detail = reason;
	if (!detail) {
		try {
			validateChatFrame(raw);
			return false;
		} catch (error) {
			detail = describeError(error);
		}
	}
	entry.finish({
		ok: false,
		error: `pw --ext result could not be delivered: ${detail}`.slice(0, 2048),
	});
	return true;
}
