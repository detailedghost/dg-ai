import type { SessionPresence } from "@dg/common";

export const CHAT_SESSION_KEY_PREFIX = "chat_session:";

export const MSG = {
	clientConnect: "dg-chat:client-connect",
	userMessage: "dg-chat:user-message",
	sessionClose: "dg-chat:session-close",
	sessionDisconnect: "dg-chat:session-disconnect",
	frame: "dg-chat:frame",
	connection: "dg-chat:connection",
	connectionRequest: "dg-chat:connection-request",
	connectionRetry: "dg-chat:connection-retry",
	sessionAttach: "dg-chat:session-attach",
	overwatchState: "dg-chat:overwatch-state",
	configRequest: "dg-chat:config-request",
	commandInvocation: "dg-chat:command-invocation",
	openChat: "dg-chat:open-chat",
	recordDemo: "dg-chat:record-demo",
	pairOfferRequest: "dg-chat:pair-offer-request",
	agentTabsRequest: "dg-chat:agent-tabs-request",
	agentTabAdopt: "dg-chat:agent-tab-adopt",
	trustDaemon: "dg-chat:trust-daemon",
} as const;

export type ConfigRelayReply = {
	key: string;
	value?: unknown;
	error?: string;
};

export type PairingRun = {
	sessionId: string;
	requestId: string;
	feature: string;
	startedAt: number;
};

export type PairingSession = {
	sessionId: string;
	agentIdentity: string;
	connected: boolean;
	presence?: SessionPresence;
	runs: PairingRun[];
};

export type PairOfferState =
	| { status: "pending"; code: string; expiresAt: number }
	| { status: "claimed"; agentIdentity: string }
	| { status: "expired" }
	| { status: "daemon-down" }
	| { status: "error"; error: string };

export type RecordDemoReply =
	| { outcome: "started" }
	| { outcome: "no-tour" }
	| { outcome: "refused"; reason: string }
	| { outcome: "capture-failed"; shortcut: string | null };

export type AgentTabView = {
	tabId: number;
	title: string;
	url: string;
	selected: boolean;
	active: boolean;
};

export type AgentTabsReply = {
	groups: Array<{ sessionId: string; color: string; tabs: AgentTabView[] }>;
};

export type AgentTabAdoptReply = { ok: true } | { ok: false; error: string };

export const PRIVATE_TAB_ERROR = "incognito tabs cannot be shared";
export const BLOCKED_TAB_ERROR = "this page cannot be shared with an agent";
