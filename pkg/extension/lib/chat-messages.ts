export const CHAT_SESSION_KEY_PREFIX = "chat_session:";

/** Chat-scoped IPC message keys — sibling to demo-messages.ts, not an addition to it. */
export const MSG = {
	// content → background: storage.session and tabs.create aren't available
	// to content scripts, so the background does both.
	markerCaptured: "dg-chat:marker-captured",
	clientConnect: "dg-chat:client-connect",
	userMessage: "dg-chat:user-message",
	sessionCreate: "dg-chat:session-create",
	sessionClose: "dg-chat:session-close",
	frame: "dg-chat:frame",
} as const;
