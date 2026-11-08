import { fail, requireOneOf, requireRecord, requireString } from "./assert";
import type { SessionPresence, SessionRole } from "./chat-format";
import { PAIR_CODE_PATTERN } from "./pairing";

export const CHAT_ATTACH_PATH = "/attach";
export const CHAT_CODE_PATH = "/chat/code";
export const CHAT_EXCHANGE_PATH = "/chat/exchange";
export const CHAT_SESSIONS_CLEAR_PATH = "/sessions/clear";
export const CHAT_SESSIONS_LOCAL_PATH = "/sessions/local";

export type AttachRequest = {
	code?: string;
	sessionId?: string;
	all?: boolean;
	intent: "attach";
};

export type AttachCandidate = {
	sessionId: string;
	token: string;
	state: "active" | "closed";
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

const CODE_REQUIRED = "Enter the 6 digit code from dg-daemon pair.";
const NONE_OPEN = "No agent session is open. Run dg-agent start, then paste the code again.";
const CHOOSE_ONE = "Choose a session, or attach every open session.";

export function validateAttachRequest(value: unknown): AttachRequest {
	requireRecord(value, "attach request");
	const intent = value.intent === undefined ? "attach" : value.intent;
	requireOneOf(intent, "attach request.intent", ["attach"] as const);
	if (value.code !== undefined) {
		requireString(value.code, "attach request.code");
		if (!PAIR_CODE_PATTERN.test(value.code)) {
			fail("attach request.code must be exactly six digits");
		}
	}
	if (value.sessionId !== undefined) {
		requireString(value.sessionId, "attach request.sessionId", { nonEmpty: true });
	}
	if (value.all !== undefined && typeof value.all !== "boolean") {
		fail("attach request.all must be a boolean");
	}
	return {
		intent,
		...(typeof value.code === "string" ? { code: value.code } : {}),
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		...(typeof value.all === "boolean" ? { all: value.all } : {}),
	};
}

/** Decides whether an extension attach call may see session capabilities. */
export function decideAttach(input: {
	intent: "attach";
	sessionId?: string;
	all?: boolean;
	codeAccepted: boolean;
	sessions: AttachCandidate[];
}): AttachDecision {
	if (!input.codeAccepted) {
		return { action: "reject", status: 401, message: CODE_REQUIRED };
	}
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
