import {
	CHAT_SESSIONS_PATH,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	selectWaitingSession,
	type SessionBootstrap,
	type WaitingCandidate,
} from "@dg/common";
import { loopbackHostHeader, readSessionToken, resolveDgPaths } from "@dg/common/node";
import { realpathSync } from "node:fs";

type CatalogSession = WaitingCandidate & { agentIdentity?: string };

function isCatalogSession(value: unknown): value is CatalogSession {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.sessionId === "string" &&
		typeof record.cwd === "string" &&
		typeof record.awaitingAgent === "boolean"
	);
}

export async function listWaitingSessions(port: number): Promise<CatalogSession[]> {
	const response = await fetch(
		`http://127.0.0.1:${port}${CHAT_SESSIONS_PATH}?waiting=1`,
		{ headers: loopbackHostHeader(port) },
	);
	if (!response.ok) {
		throw new DgCliError(
			"could not list sessions the extension is waiting on",
			EXIT_GENERAL_FAILURE,
		);
	}
	const body = (await response.json()) as { sessions?: unknown };
	if (!Array.isArray(body.sessions)) return [];
	return body.sessions.filter(isCatalogSession);
}

export type ClaimMode = "start" | "attach";

export function interpretWaitingChoice(
	sessions: CatalogSession[],
	cwd: string,
	mode: ClaimMode,
	explicitId?: string,
): { sessionId: string; agentIdentity: string } | undefined {
	let resolved = cwd;
	try {
		resolved = realpathSync(cwd);
	} catch {
		// The directory is not on disk; compare the path the caller gave.
	}
	const normalized = sessions.map((session) => {
		let sessionCwd = session.cwd;
		try {
			sessionCwd = realpathSync(session.cwd);
		} catch {
			// Keep the catalog path when it does not exist here.
		}
		return { ...session, cwd: sessionCwd };
	});
	const choice = selectWaitingSession(normalized, resolved, explicitId);
	if (!choice.ok) {
		if (choice.reason === "none" && mode === "start" && explicitId === undefined) {
			return undefined;
		}
		throw new DgCliError(choice.message, EXIT_GENERAL_FAILURE);
	}
	const match = normalized.find((session) => session.sessionId === choice.sessionId);
	const identity = match?.agentIdentity;
	return {
		sessionId: choice.sessionId,
		agentIdentity: identity ? identity : "agent",
	};
}

export async function claimWaitingSession(
	port: number,
	cwd: string,
	mode: ClaimMode,
	explicitId?: string,
): Promise<SessionBootstrap | undefined> {
	const sessions = await listWaitingSessions(port);
	const claimed = interpretWaitingChoice(sessions, cwd, mode, explicitId);
	if (!claimed) return undefined;
	return {
		port,
		sessionId: claimed.sessionId,
		token: readSessionToken(resolveDgPaths(), claimed.sessionId),
		agentIdentity: claimed.agentIdentity,
	};
}
