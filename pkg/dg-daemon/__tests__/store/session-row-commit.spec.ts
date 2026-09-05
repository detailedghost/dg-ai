import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

function recordRunCalls(): { calls: string[]; restore: () => void } {
	const calls: string[] = [];
	const original = Database.prototype.run;
	Database.prototype.run = function (
		this: Database,
		sql: string,
		...rest: unknown[]
	) {
		calls.push(sql);
		return (original as (...args: unknown[]) => unknown).apply(this, [
			sql,
			...rest,
		]);
	} as typeof Database.prototype.run;
	return {
		calls,
		restore: () => {
			Database.prototype.run = original;
		},
	};
}

function assertSessionRowInsertIsBracketedByOneTransaction(
	calls: string[],
): void {
	const beginIndex = calls.findIndex((sql) =>
		sql.trim().toUpperCase().startsWith("BEGIN"),
	);
	const commitIndex = calls.findIndex(
		(sql) => sql.trim().toUpperCase() === "COMMIT",
	);
	const sessionInsertIndex = calls.findIndex((sql) =>
		sql.includes("INSERT INTO sessions"),
	);
	expect(beginIndex).toBeGreaterThanOrEqual(0);
	expect(commitIndex).toBeGreaterThan(beginIndex);
	expect(sessionInsertIndex).toBeGreaterThan(beginIndex);
	expect(sessionInsertIndex).toBeLessThan(commitIndex);
	expect(
		calls.filter((sql) => sql.trim().toUpperCase().startsWith("BEGIN")),
	).toHaveLength(1);
}

async function withFreshStore<T>(fn: (store: ChatStore) => T): Promise<T> {
	const dgHome = freshDgHome();
	try {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		try {
			return fn(store);
		} finally {
			store.close();
		}
	} finally {
		cleanupDgHome(dgHome);
	}
}

describe("ChatStore — ensureSessionRow commits with its caller's write, not separately", () => {
	it("brackets insertMessage's session-row insert inside a single BEGIN/COMMIT", async () => {
		await withFreshStore((store) => {
			const rec = recordRunCalls();
			store.insertMessage({
				sessionId: "commit-count-message",
				id: "msg-1",
				role: "user",
				body: "hi",
			});
			rec.restore();
			assertSessionRowInsertIsBracketedByOneTransaction(rec.calls);
		});
	});

	it("brackets insertStatusEvent's session-row insert inside a single BEGIN/COMMIT", async () => {
		await withFreshStore((store) => {
			const rec = recordRunCalls();
			store.insertStatusEvent({
				sessionId: "commit-count-status",
				state: "running",
			});
			rec.restore();
			assertSessionRowInsertIsBracketedByOneTransaction(rec.calls);
		});
	});

	it("brackets insertAgentMessage's session-row insert inside a single BEGIN/COMMIT", async () => {
		await withFreshStore((store) => {
			const rec = recordRunCalls();
			store.insertAgentMessage({
				senderSessionId: "commit-count-agent",
				senderIdentity: "agent-a",
				recipientIdentity: "agent-b",
				id: "agent-msg-1",
				body: "hi",
			});
			rec.restore();
			assertSessionRowInsertIsBracketedByOneTransaction(rec.calls);
		});
	});

	it("brackets insertCommandInvocation's session-row insert inside a single BEGIN/COMMIT", async () => {
		await withFreshStore((store) => {
			const rec = recordRunCalls();
			store.insertCommandInvocation({
				sessionId: "commit-count-invocation",
				id: "inv-1",
				argv: ["echo", "hi"],
				stdout: "hi",
				stderr: "",
				truncated: false,
			});
			rec.restore();
			assertSessionRowInsertIsBracketedByOneTransaction(rec.calls);
		});
	});

	it("brackets saveCommandManifest's session-row insert inside a single BEGIN/COMMIT", async () => {
		await withFreshStore((store) => {
			const rec = recordRunCalls();
			store.saveCommandManifest({
				sessionId: "commit-count-manifest",
				commands: [{ label: "Echo", argv: ["echo", "ok"], params: [] }],
				subagentNames: [],
			});
			rec.restore();
			assertSessionRowInsertIsBracketedByOneTransaction(rec.calls);
		});
	});

	it("brackets insertAsset's session-row insert inside a single BEGIN/COMMIT", async () => {
		await withFreshStore((store) => {
			const rec = recordRunCalls();
			store.insertAsset({
				sessionId: "commit-count-asset",
				id: "asset-1",
				filename: "note.txt",
				contentType: "text/plain",
				byteLength: 4,
			});
			rec.restore();
			assertSessionRowInsertIsBracketedByOneTransaction(rec.calls);
		});
	});
});
