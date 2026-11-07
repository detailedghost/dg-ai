import { fail, requireOneOf, requireRecord, requireString } from "./assert";
import type { SessionPresence, SessionRole } from "./chat-format";

export const CHAT_ATTACH_PATH = "/attach";
export const CHAT_CODE_PATH = "/chat/code";
export const CHAT_EXCHANGE_PATH = "/chat/exchange";
export const CHAT_SESSIONS_CLEAR_PATH = "/sessions/clear";
export const CHAT_SESSIONS_LOCAL_PATH = "/sessions/local";

export type AttachRequest = {
	sessionId?: string;
	intent: "attach";
};

export type AttachDecision =
	| { action: "reject"; status: number; message: string }
	| { action: "return"; sessionIds: string[] };

export type LocalAttachCandidate = {
	sessionId: string;
	role: SessionRole;
	presence: SessionPresence;
	state: "active" | "closed";
};

const CHOOSE_ONE = "Choose a session to attach.";

export function validateAttachRequest(value: unknown): AttachRequest {
	requireRecord(value, "attach request");
	const intent = value.intent === undefined ? "attach" : value.intent;
	requireOneOf(intent, "attach request.intent", ["attach"] as const);
	if (value.code !== undefined || value.all !== undefined) {
		fail("attach request takes only a sessionId");
	}
	if (value.sessionId !== undefined) {
		requireString(value.sessionId, "attach request.sessionId", { nonEmpty: true });
	}
	return {
		intent,
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
	};
}

/** Decides which one session a local page holding a live token may attach. */
export function decideLocalAttach(input: {
	sessionId?: string;
	callerSessionId?: string;
	registry: LocalAttachCandidate[];
}): AttachDecision {
	if (input.sessionId === undefined) {
		return { action: "reject", status: 400, message: CHOOSE_ONE };
	}
	const match = input.registry.find(
		(session) =>
			session.sessionId === input.sessionId &&
			session.sessionId !== input.callerSessionId &&
			session.state === "active" &&
			session.role === "agent" &&
			session.presence === "cli",
	);
	if (!match) {
		return { action: "reject", status: 404, message: "That session is not active." };
	}
	return { action: "return", sessionIds: [match.sessionId] };
}
