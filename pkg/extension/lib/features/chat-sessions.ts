
import type { ChatFrame, ProgressState, SessionRole } from "@dg/common";

export type ChatSessionEntry = {
	sessionId: string;
	agentIdentity: string;
	role: SessionRole;
	workset?: string;
	status: ProgressState | "unknown";
	unreadCount: number;
};

export type ChatSessions = {
	applyFrame(frame: ChatFrame): void;
	list(): ChatSessionEntry[];
	get(sessionId: string): ChatSessionEntry | undefined;
	markSessionRead(sessionId: string): void;
};

export function createChatSessions(): ChatSessions {
	const roster = new Map<string, ChatSessionEntry>();

	function applySessionList(
		frame: Extract<ChatFrame, { type: "session-list" }>,
	): void {
		const next = new Map<string, ChatSessionEntry>();
		for (const summary of frame.sessions) {
			const existing = roster.get(summary.sessionId);
			next.set(summary.sessionId, {
				sessionId: summary.sessionId,
				agentIdentity: summary.agentIdentity,
				role: summary.role,
				workset: summary.workset,
				status: existing?.status ?? "unknown",
				unreadCount: existing?.unreadCount ?? 0,
			});
		}
		roster.clear();
		for (const [id, entry] of next) roster.set(id, entry);
	}

	return {
		applyFrame(frame: ChatFrame): void {
			switch (frame.type) {
				case "session-list":
					applySessionList(frame);
					return;
				case "progress": {
					const entry = roster.get(frame.sessionId);
					if (!entry) return;
					entry.status = frame.state;
					return;
				}
				case "agent-message": {
					const entry = roster.get(frame.sessionId);
					if (!entry) return;
					entry.unreadCount += 1;
					return;
				}
				case "session-closed":
					roster.delete(frame.sessionId);
					return;
				default:
					return;
			}
		},

		list(): ChatSessionEntry[] {
			return Array.from(roster.values());
		},

		get(sessionId: string): ChatSessionEntry | undefined {
			return roster.get(sessionId);
		},

		markSessionRead(sessionId: string): void {
			const entry = roster.get(sessionId);
			if (entry) entry.unreadCount = 0;
		},
	};
}
