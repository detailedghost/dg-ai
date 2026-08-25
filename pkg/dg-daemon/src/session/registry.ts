import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import type { SessionRole, SessionSummary } from "@dg/common";
import {
	type DgPaths,
	mintToken,
	removeSessionToken,
	tokensEqual,
	writeSessionToken,
} from "@dg/common/node";
import { triggerAssetCleanup } from "../utils/asset-cleanup";

export type SessionState = "active" | "closed";

export type SessionRecord = {
	sessionId: string;
	token: string;
	cwd: string;
	agentIdentity: string;
	workset?: string;
	role: SessionRole;
	state: SessionState;
	createdAt: number;
	lastActivityAt: number;
	closedAt?: number;
};

export type CreateSessionInput = {
	cwd: string;
	agentIdentity: string;
	workset?: string;
	role: SessionRole;
};

export type CloseReason = "cli" | "canvas" | "daemon-shutdown" | "expired";

export type SessionRegistrySeams = {
	now?: () => number;
};

/** Bounds how long a closed record lingers for `get()`/asset-serving distinctions before eviction. */
const CLOSED_RECORD_RETENTION_MS = 10 * 60 * 1000;

export class SessionRegistry extends EventEmitter {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly now: () => number;

	constructor(
		private readonly paths: DgPaths,
		seams: SessionRegistrySeams = {},
	) {
		super();
		this.now = seams.now ?? Date.now;
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
			createdAt,
			lastActivityAt: createdAt,
		};
		this.sessions.set(record.sessionId, record);
		writeSessionToken(this.paths, record.sessionId, {
			sessionId: record.sessionId,
			token: record.token,
			cwd: record.cwd,
			agentIdentity: record.agentIdentity,
		});
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
		removeSessionToken(this.paths, sessionId);
		triggerAssetCleanup(sessionId);
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
	): string[] {
		const now = this.now();
		const expired: string[] = [];
		for (const record of [...this.sessions.values()]) {
			if (record.state !== "active") continue;
			if (now - record.lastActivityAt < ttlMs) continue;
			if (isExempt(record.sessionId)) continue;
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

	list(): SessionSummary[] {
		return [...this.sessions.values()]
			.filter((record) => record.state === "active")
			.map((record) => ({
				sessionId: record.sessionId,
				agentIdentity: record.agentIdentity,
				role: record.role,
				...(record.workset !== undefined ? { workset: record.workset } : {}),
			}));
	}

	activeCount(): number {
		let count = 0;
		for (const record of this.sessions.values())
			if (record.state === "active") count++;
		return count;
	}
}
