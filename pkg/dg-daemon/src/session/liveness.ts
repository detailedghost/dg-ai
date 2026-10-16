import { DEFAULT_IDLE_TTL_MS } from "../server/idle-ttl";

export const DEFAULT_AGENT_GONE_MS = 60_000;
export const DEFAULT_UNCLAIMED_TTL_MS = 5 * 60_000;
/** How long a claimed session may sit between CLI commands before the claim is released. */
export const DEFAULT_CLI_REATTACH_GRACE_MS = DEFAULT_IDLE_TTL_MS;

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
 * A held CLI claim (or the exempt flag the daemon sets for an open CLI socket)
 * keeps a session. Extension keepalives must not: they never update the clocks
 * this reads. After the reattach grace releases the claim, the session expires
 * agentGoneMs later even if a page socket is still open.
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

export type ClaimSnapshot = {
	cliAttached: boolean;
	cliQuietSince?: number;
	socketOpen: boolean;
};

/**
 * A claim outlives each short-lived CLI socket. It releases only after the
 * quiet clock has run for the whole grace with no reattach and no open socket.
 */
export function shouldReleaseClaim(
	snapshot: ClaimSnapshot,
	now: number,
	graceMs: number,
): boolean {
	if (snapshot.socketOpen) return false;
	if (!snapshot.cliAttached) return false;
	if (snapshot.cliQuietSince === undefined) return false;
	return now - snapshot.cliQuietSince >= graceMs;
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
