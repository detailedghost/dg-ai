import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	CLI_SESSION_ID_HEADER,
	type CredentialsCliRequest,
	credentialNameInPrefix,
	validateCredentialGrantPrefix,
} from "@dg/common";
import {
	removeCredentialGrantToken,
	writeCredentialGrantToken,
} from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import { isExtensionPeer, type SocketState, sendViaQueue } from "./connection";
import type { CredentialStore } from "../store/credentials-store";
import type { FrameHandlerDeps } from "./frame-handlers";

type Socket = ServerWebSocket<SocketState>;
export type Result = { ok: true; value: unknown } | { ok: false; error: string };
type Access = { scope: "session" } | { scope: "prefix"; prefix: string };

export const EXTENSION_CREDENTIAL_PREFIX = "extension";
export const NOT_ALLOWED = "Credential request not allowed for this caller.";
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
			? { scope: "prefix", prefix: validateCredentialGrantPrefix(frame.grant.prefix) }
			: undefined;
	const sessionId = socketSessionId(requester);
	if (!sessionId) return undefined;
	if (requester.data.localPage) return undefined;
	if (isExtensionPeer(requester))
		return { scope: "prefix", prefix: EXTENSION_CREDENTIAL_PREFIX };
	return deps.registry.get(sessionId)?.state === "active"
		? { scope: "session" }
		: undefined;
}

/** Reads under one prefix; a `get` input must carry a string name. */
export function scopedRead(
	input: { operation: string; name?: string },
	prefix: string,
	store: Pick<CredentialStore, "listCredentials" | "getCredential">,
): Result {
	if (input.operation === "list")
		return {
			ok: true,
			value: store
				.listCredentials()
				.filter((entry) => credentialNameInPrefix(entry.name, prefix)),
		};
	if (input.operation === "get" && credentialNameInPrefix(input.name!, prefix))
		return { ok: true, value: store.getCredential(input.name!) ?? null };
	return { ok: false, error: NOT_ALLOWED };
}

export function hasCredentialGrant(
	req: Request,
	store: Pick<CredentialStore, "verifyCredentialGrant">,
): boolean {
	const prefix = req.headers.get(CLI_GRANT_PREFIX_HEADER);
	const token = req.headers.get(CLI_GRANT_TOKEN_HEADER);
	return (
		prefix !== null &&
		token !== null &&
		!req.headers.has(CLI_SESSION_ID_HEADER) &&
		store.verifyCredentialGrant(prefix, token)
	);
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
			const prefix = validateCredentialGrantPrefix(frame.prefix!);
			const token = store.createCredentialGrant(prefix);
			return {
				prefix,
				path: writeCredentialGrantToken(deps.paths, prefix, token),
			};
		}
		case "revoke": {
			const prefix = validateCredentialGrantPrefix(frame.prefix!);
			removeCredentialGrantToken(deps.paths, prefix);
			return store.deleteCredentialGrant(prefix);
		}
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
			answer = scopedRead(frame, access.prefix, deps.credentials);
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
