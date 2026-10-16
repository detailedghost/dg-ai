import { fail, requireOneOf, requireRecord, requireString } from "./assert";
import type { SessionRole } from "./chat-format";

export const CHAT_ATTACH_PATH = "/attach";
export const CHAT_SESSIONS_PATH = "/sessions";
export const CHAT_SESSIONS_CLEAR_PATH = "/sessions/clear";

export type AttachIntent = "attach" | "create";

export type AttachRequest = {
	code?: string;
	sessionId?: string;
	all?: boolean;
	intent: AttachIntent;
	workset?: string;
	agentIdentity?: string;
	role?: SessionRole;
};

export type AttachCandidate = {
	sessionId: string;
	token: string;
	state: "active" | "closed";
};

export type AttachDecision =
	| { action: "reject"; status: number; message: string }
	| { action: "return"; sessionIds: string[] }
	| { action: "create" };

export type WaitingCandidate = {
	sessionId: string;
	cwd: string;
	awaitingAgent: boolean;
	token?: string;
};

export type WaitingChoice =
	| { ok: true; sessionId: string }
	| { ok: false; reason: "none" | "ambiguous" | "missing" | "not-waiting"; message: string };

const CODE_REQUIRED = "Enter the 6 digit code from dg-daemon pair.";
const NONE_OPEN = "No CLI session is open. Create one here, or run dg-agent start.";
const CHOOSE_ONE = "Choose a session, or attach every open session.";

export function validateAttachRequest(value: unknown): AttachRequest {
	requireRecord(value, "attach request");
	const intent = value.intent === undefined ? "attach" : value.intent;
	requireOneOf(intent, "attach request.intent", ["attach", "create"] as const);
	if (value.code !== undefined) {
		requireString(value.code, "attach request.code");
		if (!/^\d{6}$/.test(value.code)) {
			fail("attach request.code must be exactly six digits");
		}
	}
	if (value.sessionId !== undefined) {
		requireString(value.sessionId, "attach request.sessionId", { nonEmpty: true });
	}
	if (value.all !== undefined && typeof value.all !== "boolean") {
		fail("attach request.all must be a boolean");
	}
	if (value.workset !== undefined) {
		requireString(value.workset, "attach request.workset", { nonEmpty: true });
	}
	if (value.agentIdentity !== undefined) {
		requireString(value.agentIdentity, "attach request.agentIdentity", {
			nonEmpty: true,
		});
	}
	if (value.role !== undefined) {
		requireOneOf(value.role, "attach request.role", ["orchestrator", "agent"] as const);
	}
	return {
		intent,
		...(typeof value.code === "string" ? { code: value.code } : {}),
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		...(typeof value.all === "boolean" ? { all: value.all } : {}),
		...(typeof value.workset === "string" ? { workset: value.workset } : {}),
		...(typeof value.agentIdentity === "string"
			? { agentIdentity: value.agentIdentity }
			: {}),
		...(value.role === "orchestrator" || value.role === "agent"
			? { role: value.role }
			: {}),
	};
}

/** Decides whether an extension attach call may see session capabilities. */
export function decideAttach(input: {
	intent: AttachIntent;
	sessionId?: string;
	all?: boolean;
	pinned: boolean;
	codeAccepted: boolean;
	sessions: AttachCandidate[];
}): AttachDecision {
	if (!input.codeAccepted && !input.pinned) {
		return { action: "reject", status: 401, message: CODE_REQUIRED };
	}
	if (input.intent === "create") return { action: "create" };
	const active = input.sessions.filter((session) => session.state === "active");
	if (input.sessionId !== undefined) {
		const match = active.find((session) => session.sessionId === input.sessionId);
		if (!match) {
			return {
				action: "reject",
				status: 404,
				message: "That session is not active.",
			};
		}
		return { action: "return", sessionIds: [match.sessionId] };
	}
	if (input.all !== true) {
		return { action: "reject", status: 400, message: CHOOSE_ONE };
	}
	if (active.length === 0) {
		return { action: "reject", status: 404, message: NONE_OPEN };
	}
	return { action: "return", sessionIds: active.map((session) => session.sessionId) };
}

/** Picks the session an already-running CLI should claim. */
export function selectWaitingSession(
	sessions: WaitingCandidate[],
	cwd: string,
	explicitId?: string,
): WaitingChoice {
	const waiting = sessions.filter((session) => session.awaitingAgent);
	if (explicitId !== undefined) {
		const match = sessions.find((session) => session.sessionId === explicitId);
		if (!match) {
			return {
				ok: false,
				reason: "missing",
				message: `No session ${explicitId} is registered.`,
			};
		}
		if (!match.awaitingAgent) {
			return {
				ok: false,
				reason: "not-waiting",
				message: `Session ${explicitId} is not waiting for an agent.`,
			};
		}
		return { ok: true, sessionId: match.sessionId };
	}
	if (waiting.length === 0) {
		return {
			ok: false,
			reason: "none",
			message: "No session is waiting for an agent in this directory.",
		};
	}
	if (waiting.length === 1) {
		const only = waiting[0];
		return { ok: true, sessionId: only.sessionId };
	}
	const matches = waiting.filter((session) => session.cwd === cwd);
	if (matches.length === 1) {
		const match = matches[0];
		return { ok: true, sessionId: match.sessionId };
	}
	const listed = matches.length > 1 ? matches : waiting;
	const ids = listed.map((session) => session.sessionId).join(", ");
	const where = matches.length > 1 ? "in this directory" : "for an agent";
	return {
		ok: false,
		reason: "ambiguous",
		message: `Several sessions are waiting ${where}. Pass --session. ${ids}`,
	};
}
