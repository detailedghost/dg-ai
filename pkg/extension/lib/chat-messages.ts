export const CHAT_SESSION_KEY_PREFIX = "chat_session:";

export const MSG = {
	markerCaptured: "dg-chat:marker-captured",
	clientConnect: "dg-chat:client-connect",
	userMessage: "dg-chat:user-message",
	sessionCreate: "dg-chat:session-create",
	sessionClose: "dg-chat:session-close",
	frame: "dg-chat:frame",
	configRequest: "dg-chat:config-request",
	commandInvocation: "dg-chat:command-invocation",
} as const;

export type ConfigRelayReply = {
	key: string;
	value?: unknown;
	error?: string;
};
