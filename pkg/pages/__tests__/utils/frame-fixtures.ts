import { CHAT_PROTOCOL_VERSION } from "@dg/common";

export function buildAgentMessageFrame(
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "agent-message" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		body: "here is my answer",
		...overrides,
	};
}

export type SessionListEntry = {
	sessionId: string;
	agentIdentity: string;
	role?: "orchestrator" | "agent";
	workset?: string;
};

export function buildSessionListFrame(
	sessions: SessionListEntry[],
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "session-list" as const,
		sessionId: sessions[0]?.sessionId ?? "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		sessions: sessions.map((s) => ({ role: "agent" as const, ...s })),
		...overrides,
	};
}
