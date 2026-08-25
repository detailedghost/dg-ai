import type { ChatFrame, CommandEntry } from "./chat-format";

export const CLI_SESSION_ID_HEADER = "X-Dg-Session-Id";
export const CLI_SESSION_TOKEN_HEADER = "X-Dg-Session-Token";
export const ASSET_FILENAME_HEADER = "X-Dg-Filename";

export type CliRecvRequest = {
	type: "cli-recv";
	block: boolean;
	timeoutMs?: number;
};

export type CliRecvResult =
	| {
			type: "cli-recv-result";
			outcome: "delivered";
			message: Record<string, unknown>;
	  }
	| { type: "cli-recv-result"; outcome: "empty" | "timeout" | "closed" };

export type CliAckRequest = { type: "cli-ack"; claimId: string };

export type CliSendRequest = { type: "cli-send"; body: string; to?: string };

export type CliProgressRequest = {
	type: "cli-progress";
	state: "running" | "awaiting-input";
};

export type CliManifestPublishRequest = {
	type: "cli-manifest-publish";
	commands: CommandEntry[];
	subagents?: string[];
};

export type CliFrame =
	| CliRecvRequest
	| CliAckRequest
	| CliSendRequest
	| CliProgressRequest
	| CliManifestPublishRequest;

export type CliRequest =
	| CliFrame
	| Extract<ChatFrame, { type: "session-create" | "session-close" }>;
