import type { Log } from "./engine";
import { isCustomReactionId } from "./providers/teams-relay/reaction-id";
import type { ChatReaction } from "./providers/types";

export const REACTION_STATES = [
	"pending",
	"inProgress",
	"approved",
	"changesRequested",
	"comment",
	"failure",
] as const;

export type ReactionState = (typeof REACTION_STATES)[number];

export type ReactionOp = { op: "delete" | "put"; reactionId: string };

const ALLOWED: Record<ReactionState | "none", readonly ReactionState[]> = {
	none: ["pending", "failure"],
	pending: ["inProgress", "failure"],
	inProgress: ["approved", "changesRequested", "comment", "failure"],
	approved: [],
	changesRequested: [],
	comment: [],
	failure: [],
};

export function transition(
	from: ReactionState | null,
	to: ReactionState,
	ids: Record<ReactionState, string>,
): ReactionOp[] {
	if (!ALLOWED[from ?? "none"].includes(to)) {
		throw new Error(`reaction transition ${from ?? "none"} -> ${to} is not allowed`);
	}
	const put: ReactionOp = { op: "put", reactionId: ids[to] };
	return from === null ? [put] : [{ op: "delete", reactionId: ids[from] }, put];
}

export function capturedReactionId(
	reaction: ChatReaction,
	{ messageIds, since, log }: { messageIds: readonly string[]; since: number; log: Log },
): string | undefined {
	if (!messageIds.includes(reaction.messageId)) {
		log.info(`Skipping reaction on another message: ${reaction.messageId}`);
		return undefined;
	}
	if (
		reaction.action !== "added" ||
		reaction.from.isBot ||
		!(Date.parse(reaction.timestamp) >= since)
	)
		return undefined;
	if (!isCustomReactionId(reaction.type)) {
		log.info(
			`Skipping ${reaction.type.includes(";0-") ? "malformed custom" : "built-in"} reaction: ${reaction.type}`,
		);
		return undefined;
	}
	return reaction.type;
}
