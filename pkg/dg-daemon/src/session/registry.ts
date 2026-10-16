import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import type { SessionPresence, SessionRole, SessionSummary } from "@dg/common";
import {
	type DgPaths,
	mintToken,
	removeSessionToken,
	tokensEqual,
} from "@dg/common/node";
import type { SessionPersistence } from "./persistence";
import { triggerAssetCleanup } from "../utils/asset-cleanup";
import {
	DEFAULT_AGENT_GONE_MS,
	DEFAULT_CLI_REATTACH_GRACE_MS,
	DEFAULT_UNCLAIMED_TTL_MS,
	isManuallyClearable,
	shouldReapSession,
	shouldReleaseClaim,
} from "./liveness";

export type SessionState = "active" | "closed";

export type SessionRecord = {
	sessionId: string;
	token: string;
	cwd: string;
	agentIdentity: string;
	workset?: string;
	role: SessionRole;
	state: SessionState;
	awaitingAgent: boolean;
	cliAttached: boolean;
	createdAt: number;
	lastActivityAt: number;
	/** Set when the last CLI socket closed while the claim is still held. */
	cliQuietSince?: number;
	cliDetachedAt?: number;
	closedAt?: number;
};

export type CreateSessionInput = {
	cwd: string;
	agentIdentity: string;
	workset?: string;
	role: SessionRole;
	awaitingAgent?: boolean;
};

export type CloseReason = "cli" | "canvas" | "daemon-shutdown" | "expired";

export type SessionRegistrySeams = {
	now?: () => number;
	store?: SessionPersistence;
};

/** Bounds how long a closed record lingers for `get()`/asset-serving distinctions before eviction. */
const CLOSED_RECORD_RETENTION_MS = 10 * 60 * 1000;

export class SessionRegistry extends EventEmitter {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly now: () => number;
	private readonly store: SessionPersistence | undefined;

	constructor(
		private readonly paths: DgPaths,
		seams: SessionRegistrySeams = {},
	) {
		super();
		this.now = seams.now ?? Date.now;
		this.store = seams.store;
		for (const record of this.store?.loadSessions() ?? []) {
			if (record.state !== "active") continue;
			this.sessions.set(record.sessionId, { ...record, state: "active" });
		}
	}

	private persist(record: SessionRecord): void {
		this.store?.saveSession(record);
	}

	create(input: CreateSessionInput): SessionRecord {
		const createdAt = this.now();
		const record: SessionRecord = {
			sessionId: randomUUID(),
			token: mintToken(),
			cwd: realpathSync(input.cwd),
			agentIdentity: input.agentIdentity,
			workset: input.workset,
			role: input.role,
			state: "active",
			awaitingAgent: input.awaitingAgent === true,
			cliAttached: false,
			createdAt,
			lastActivityAt: createdAt,
		};
		this.sessions.set(record.sessionId, record);
		this.persist(record);
		this.emit("changed", { sessionId: record.sessionId });
		return record;
	}

	get(sessionId: string): SessionRecord | undefined {
		return this.sessions.get(sessionId);
	}

	touch(sessionId: string): void {
		const record = this.sessions.get(sessionId);
		if (!record || record.state !== "active") return;
		record.lastActivityAt = this.now();
		this.persist(record);
	}

	noteCliAttached(sessionId: string): void {
		const record = this.sessions.get(sessionId);
		if (!record || record.state !== "active") return;
		record.cliAttached = true;
		record.awaitingAgent = false;
		record.cliQuietSince = undefined;
		record.cliDetachedAt = undefined;
		record.lastActivityAt = this.now();
		this.persist(record);
	}

	/** The last CLI socket for this claim closed. The claim itself stays held. */
	noteCliQuiet(sessionId: string): void {
		const record = this.sessions.get(sessionId);
		if (!record || record.state !== "active" || !record.cliAttached) return;
		if (record.cliQuietSince !== undefined) return;
		record.cliQuietSince = this.now();
		this.persist(record);
	}

	noteCliDetached(sessionId: string): void {
		const record = this.sessions.get(sessionId);
		if (!record || record.state !== "active" || !record.cliAttached) return;
		record.cliAttached = false;
		record.cliDetachedAt = this.now();
		this.persist(record);
		this.emit("agent-gone", { sessionId });
	}

	validate(sessionId: string, token: string): boolean {
		const record = this.sessions.get(sessionId);
		return (
			record !== undefined &&
			record.state === "active" &&
			tokensEqual(record.token, token)
		);
	}

	close(sessionId: string, reason: CloseReason): boolean {
		const record = this.sessions.get(sessionId);
		if (!record || record.state === "closed") return false;
		record.state = "closed";
		record.closedAt = this.now();
		if (reason === "daemon-shutdown") {
			this.store?.saveSession({ ...record, state: "active", cliAttached: false });
		} else {
			this.store?.archiveSession(record, reason);
			removeSessionToken(this.paths, sessionId);
			triggerAssetCleanup(sessionId);
		}
		this.emit("closed", { sessionId, reason });
		this.emit("changed", { sessionId });
		return true;
	}

	closeAll(reason: CloseReason): void {
		for (const sessionId of [...this.sessions.keys()])
			this.close(sessionId, reason);
	}

	reapExpired(
		ttlMs: number,
		isExempt: (sessionId: string) => boolean,
		limits: {
			agentGoneMs?: number;
			unclaimedTtlMs?: number;
			reattachGraceMs?: number;
		} = {},
	): string[] {
		const now = this.now();
		const graceMs = limits.reattachGraceMs ?? DEFAULT_CLI_REATTACH_GRACE_MS;
		for (const record of [...this.sessions.values()]) {
			if (
				!shouldReleaseClaim(
					{
						cliAttached: record.cliAttached,
						cliQuietSince: record.cliQuietSince,
						socketOpen: isExempt(record.sessionId),
					},
					now,
					graceMs,
				)
			) {
				continue;
			}
			this.noteCliDetached(record.sessionId);
		}
		const reapLimits = {
			sessionTtlMs: ttlMs,
			agentGoneMs: limits.agentGoneMs ?? DEFAULT_AGENT_GONE_MS,
			unclaimedTtlMs: limits.unclaimedTtlMs ?? DEFAULT_UNCLAIMED_TTL_MS,
		};
		const expired: string[] = [];
		for (const record of [...this.sessions.values()]) {
			if (
				!shouldReapSession(
					{
						state: record.state,
						createdAt: record.createdAt,
						lastActivityAt: record.lastActivityAt,
						awaitingAgent: record.awaitingAgent,
						cliAttached: record.cliAttached,
						cliDetachedAt: record.cliDetachedAt,
						exempt: isExempt(record.sessionId),
					},
					now,
					reapLimits,
				)
			) {
				continue;
			}
			this.close(record.sessionId, "expired");
			expired.push(record.sessionId);
		}
		for (const record of [...this.sessions.values()]) {
			if (record.state !== "closed" || record.closedAt === undefined) continue;
			if (now - record.closedAt < CLOSED_RECORD_RETENTION_MS) continue;
			this.sessions.delete(record.sessionId);
		}
		return expired;
	}

	presence(record: SessionRecord): SessionPresence {
		if (record.cliAttached) return "cli";
		if (record.awaitingAgent) return "waiting";
		if (record.cliDetachedAt !== undefined) return "gone";
		return "idle";
	}

	list(): SessionSummary[] {
		return [...this.sessions.values()]
			.filter((record) => record.state === "active")
			.map((record) => ({
				sessionId: record.sessionId,
				agentIdentity: record.agentIdentity,
				role: record.role,
				presence: this.presence(record),
				...(record.workset !== undefined ? { workset: record.workset } : {}),
			}));
	}

	clearDisconnected(): string[] {
		const closed: string[] = [];
		for (const record of [...this.sessions.values()]) {
			if (!isManuallyClearable(record)) continue;
			this.close(record.sessionId, "expired");
			closed.push(record.sessionId);
		}
		return closed;
	}

	activeCount(): number {
		let count = 0;
		for (const record of this.sessions.values())
			if (record.state === "active") count++;
		return count;
	}
}
