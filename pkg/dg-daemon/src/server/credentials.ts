import { type CredentialsCliRequest, credentialNameInPrefix } from "@dg/common";
import {
	removeCredentialGrantToken,
	writeCredentialGrantToken,
} from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import { type SocketState, sendViaQueue } from "./connection";
import type { FrameHandlerDeps } from "./frame-handlers";

type Socket = ServerWebSocket<SocketState>;
type Result = { ok: true; value: unknown } | { ok: false; error: string };
type Access = { scope: "session" } | { scope: "prefix"; prefix: string };

export const EXTENSION_CREDENTIAL_PREFIX = "extension";
const NOT_ALLOWED = "Credential request not allowed for this caller.";
const TRANSPORT_ERROR_SESSION_ID = "transport-error";

function socketSessionId(socket: Socket): string | undefined {
	return socket.data.capabilities.keys().next().value;
}

/** Sends the correlated result; the sessionId is the socket's session when it has one. */
export function sendCredentialsResult(
	requester: Socket,
	requestId: string,
	answer: Result,
): Promise<void> {
	return sendViaQueue(
		requester,
		JSON.stringify({
			type: "cli-credentials-result",
			sessionId: socketSessionId(requester) ?? TRANSPORT_ERROR_SESSION_ID,
			requestId,
			...answer,
		}),
	);
}

function resolveAccess(
	requester: Socket,
	frame: CredentialsCliRequest,
	deps: FrameHandlerDeps,
): Access | undefined {
	if (frame.grant)
		return deps.credentials.verifyCredentialGrant(
			frame.grant.prefix,
			frame.grant.token,
		)
			? { scope: "prefix", prefix: frame.grant.prefix }
			: undefined;
	const sessionId = socketSessionId(requester);
	if (!sessionId) return undefined;
	if (requester.data.kind === "ws")
		return { scope: "prefix", prefix: EXTENSION_CREDENTIAL_PREFIX };
	return deps.registry.get(sessionId)?.state === "active"
		? { scope: "session" }
		: undefined;
}

function scopedRead(
	frame: CredentialsCliRequest,
	prefix: string,
	deps: FrameHandlerDeps,
): Result {
	if (frame.operation === "list")
		return {
			ok: true,
			value: deps.credentials
				.listCredentials()
				.filter((entry) => credentialNameInPrefix(entry.name, prefix)),
		};
	if (frame.operation === "get" && credentialNameInPrefix(frame.name!, prefix))
		return {
			ok: true,
			value: deps.credentials.getCredential(frame.name!) ?? null,
		};
	return { ok: false, error: NOT_ALLOWED };
}

function sessionOperation(
	frame: CredentialsCliRequest,
	deps: FrameHandlerDeps,
): unknown {
	const store = deps.credentials;
	switch (frame.operation) {
		case "set":
			store.setCredential(frame.name!, frame.value!, frame.meta);
			return null;
		case "get":
			return store.getCredential(frame.name!) ?? null;
		case "list":
			return store.listCredentials();
		case "delete":
			return store.deleteCredential(frame.name!);
		case "grant": {
			const token = store.createCredentialGrant(frame.prefix!);
			return {
				prefix: frame.prefix,
				path: writeCredentialGrantToken(deps.paths, frame.prefix!, token),
			};
		}
		case "revoke":
			removeCredentialGrantToken(deps.paths, frame.prefix!);
			return store.deleteCredentialGrant(frame.prefix!);
		case "grant-list":
			return store.listCredentialGrants();
	}
}

/** Serves a session with full access, and a service grant or the extension with get/list under one prefix. */
export async function handleCredentialsRequest(
	requester: Socket,
	frame: CredentialsCliRequest,
	deps: FrameHandlerDeps,
): Promise<void> {
	let answer: Result;
	try {
		const access = resolveAccess(requester, frame, deps);
		if (!access) answer = { ok: false, error: NOT_ALLOWED };
		else if (access.scope === "prefix")
			answer = scopedRead(frame, access.prefix, deps);
		else answer = { ok: true, value: sessionOperation(frame, deps) };
	} catch {
		answer = {
			ok: false,
			error:
				"Credential storage failed; check daemon health and encryption key access.",
		};
	}
	await sendCredentialsResult(requester, frame.requestId, answer);
}
