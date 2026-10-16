export const DEFAULT_AGENT_GONE_MS = 60_000;
export const DEFAULT_UNCLAIMED_TTL_MS = 5 * 60_000;

export type ReapSnapshot = {
	state: "active" | "closed";
	createdAt: number;
	lastActivityAt: number;
	awaitingAgent: boolean;
	cliAttached: boolean;
	cliDetachedAt?: number;
	exempt: boolean;
};

export type ReapLimits = {
	sessionTtlMs: number;
	agentGoneMs: number;
	unclaimedTtlMs: number;
};

/**
 * A live CLI socket (or the exempt flag the daemon sets for one) keeps a session.
 * Extension keepalives must not: they never update the clocks this reads.
 * A detached CLI expires after agentGoneMs even if a page socket is still open.
 */
export function shouldReapSession(
	snapshot: ReapSnapshot,
	now: number,
	limits: ReapLimits,
): boolean {
	if (snapshot.state !== "active") return false;
	if (snapshot.exempt || snapshot.cliAttached) return false;
	if (snapshot.awaitingAgent) {
		return now - snapshot.createdAt >= limits.unclaimedTtlMs;
	}
	if (snapshot.cliDetachedAt !== undefined) {
		return now - snapshot.cliDetachedAt >= limits.agentGoneMs;
	}
	return now - snapshot.lastActivityAt >= limits.sessionTtlMs;
}

/** Manual clear drops sessions no CLI is driving, and leaves ones still waiting for an agent. */
export function isManuallyClearable(snapshot: {
	state: "active" | "closed";
	cliAttached: boolean;
	awaitingAgent: boolean;
}): boolean {
	return (
		snapshot.state === "active" &&
		!snapshot.cliAttached &&
		!snapshot.awaitingAgent
	);
}
