export const CHAT_SESSION_KEY_PREFIX = "chat_session:";

export const MSG = {
	markerCaptured: "dg-chat:marker-captured",
	clientConnect: "dg-chat:client-connect",
	userMessage: "dg-chat:user-message",
	sessionCreate: "dg-chat:session-create",
	sessionClose: "dg-chat:session-close",
	sessionDisconnect: "dg-chat:session-disconnect",
	frame: "dg-chat:frame",
	connection: "dg-chat:connection",
	connectionRequest: "dg-chat:connection-request",
	connectionRetry: "dg-chat:connection-retry",
	sessionAttach: "dg-chat:session-attach",
	sessionLaunch: "dg-chat:session-launch",
	sessionClear: "dg-chat:session-clear",
	sessionCatalog: "dg-chat:session-catalog",
	bootstrapsRequest: "dg-chat:bootstraps-request",
	overwatchState: "dg-chat:overwatch-state",
	configRequest: "dg-chat:config-request",
	commandInvocation: "dg-chat:command-invocation",
} as const;

export type ConfigRelayReply = {
	key: string;
	value?: unknown;
	error?: string;
};

export type PairingSession = {
	sessionId: string;
	agentIdentity: string;
	connected: boolean;
	current?: boolean;
};
