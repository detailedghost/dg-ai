import type { CodexPacket } from "../classifier/types";
import type { MailProvider } from "../providers/types";

export type WorkspaceLogin = {
	kind: "workspace-login";
	provider?: MailProvider;
	accountProfile?: string;
	username: string;
	workspaceDir: string;
	sessionProfile: string;
	apiBaseUrl: string;
	liveBrowser: boolean;
	browserType: string;
	browserHeadless: boolean;
	browserExecutablePath?: string;
	gmailApiBaseUrl?: string;
	googleAuthMode?: "browser" | "device-code" | "env";
	outlookGraphBaseUrl?: string;
	outlookAuthMode?: "browser" | "device-code" | "silent" | "env";
	createdAt: string;
	updatedAt: string;
};

export type MessagePipelineStatus =
	| "fetched"
	| "exported"
	| "classified"
	| "planned"
	| "dry_run"
	| "applied"
	| "skipped"
	| "failed";

export type MessageDecision = {
	action: "move" | "keep" | "review" | "skip";
	targetFolder?: string;
	markRead?: boolean;
	confidence?: number;
	reason?: string;
	filterGap?: string;
};

export type MessageWorkItem = {
	kind: "message-work-item";
	id: string;
	sourceMessageId: string;
	sourceIdHash: string;
	file: string;
	status: MessagePipelineStatus;
	statusUpdatedAt: string;
	receivedAt?: string;
	currentFolder: string;
	packet: CodexPacket;
	decision?: MessageDecision;
	error?: string;
};

export type MessageStatusEntry = {
	id: string;
	file: string;
	status: MessagePipelineStatus;
	statusUpdatedAt: string;
	currentFolder: string;
	fromDomain: string;
	subject: string;
	decision?: MessageDecision;
	error?: string;
};

export type MessageStatusIndex = {
	kind: "message-status-index";
	provider?: MailProvider;
	createdAt: string;
	updatedAt: string;
	total: number;
	counts: Record<MessagePipelineStatus, number>;
	items: MessageStatusEntry[];
};

export type ClassificationGuide = {
	kind: "classification-guide";
	createdAt: string;
	modelGuidance: string;
	instructions: string[];
	allowedActions: MessageDecision["action"][];
	folders: unknown[];
	filters: unknown[];
	messageStatusPath: string;
	messageFilesGlob: string;
};
