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
};

export type CreateSessionInput = {
	cwd: string;
	agentIdentity: string;
	workset?: string;
	role: SessionRole;
};

export type CloseReason = "cli" | "canvas" | "daemon-shutdown";

export class SessionRegistry extends EventEmitter {
	private readonly sessions = new Map<string, SessionRecord>();

	constructor(private readonly paths: DgPaths) {
		super();
	}

	create(input: CreateSessionInput): SessionRecord {
		const record: SessionRecord = {
			sessionId: randomUUID(),
			token: mintToken(),
			cwd: realpathSync(input.cwd),
			agentIdentity: input.agentIdentity,
			workset: input.workset,
			role: input.role,
			state: "active",
			createdAt: Date.now(),
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
