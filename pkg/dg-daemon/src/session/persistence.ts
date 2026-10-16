import type { SessionRole } from "@dg/common";

/** Chat session row stored in the daemon database. The token is encrypted at rest. */
export type PersistedSession = {
	sessionId: string;
	token: string;
	cwd: string;
	agentIdentity: string;
	workset?: string;
	role: SessionRole;
	state: "active" | "closed" | "archived";
	awaitingAgent: boolean;
	cliAttached: boolean;
	createdAt: number;
	lastActivityAt: number;
	cliQuietSince?: number;
	cliDetachedAt?: number;
	closedAt?: number;
};

export type ArchivePruneCounts = {
	sessions: number;
	messages: number;
};

export type SessionPersistence = {
	saveSession(record: PersistedSession): void;
	loadSessions(): PersistedSession[];
	archiveSession(record: PersistedSession, reason: string): void;
	pruneArchive(
		now: number,
		limits: { maxRows: number; ttlMs: number },
	): ArchivePruneCounts;
	walPageCount(): number;
	checkpointPassive(): void;
};
