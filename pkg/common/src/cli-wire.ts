import type {
	ChatFrame,
	CommandEntry,
	OverwatchBoard,
	OverwatchLane,
	OverwatchMerge,
} from "./chat-format";

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

export type CliOverwatchSetRequest = {
	type: "cli-overwatch-set";
} & Omit<OverwatchLane, "publisher" | "updatedAt">;

export type CliOverwatchRemoveRequest = {
	type: "cli-overwatch-remove";
	chat: string;
};

export type CliOverwatchMergedRequest = {
	type: "cli-overwatch-merged";
} & Omit<OverwatchMerge, "at">;

export type CliOverwatchLaunchRequest = {
	type: "cli-overwatch-launch";
	goLive: string;
	goNoGo?: string;
};

export type CliOverwatchOpenRequest = { type: "cli-overwatch-open" };

export type CliOverwatchSnapshotRequest = { type: "cli-overwatch-snapshot" };

export type CliOverwatchSnapshotResult = {
	type: "cli-overwatch-snapshot-result";
	board: OverwatchBoard;
};

export type CliFrame =
	| CliRecvRequest
	| CliAckRequest
	| CliSendRequest
	| CliProgressRequest
	| CliManifestPublishRequest
	| CliOverwatchSetRequest
	| CliOverwatchRemoveRequest
	| CliOverwatchMergedRequest
	| CliOverwatchLaunchRequest
	| CliOverwatchOpenRequest
	| CliOverwatchSnapshotRequest;

export type CliRequest =
	| CliFrame
	| Extract<ChatFrame, { type: "session-create" | "session-close" }>;
