import type { ChatFrame, CommandEntry } from "@dg/common";

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

export type CliSendRequest = { type: "cli-send"; body: string };

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
