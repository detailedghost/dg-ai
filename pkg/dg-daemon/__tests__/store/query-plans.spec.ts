import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	AGENT_MESSAGE_ACK_SQL,
	AGENT_MESSAGE_CLAIM_SQL,
	MESSAGE_ACK_SQL,
	MESSAGE_CLAIM_SQL,
} from "../../src/store";
import { SCHEMA_STEPS } from "../../src/store/schema";

const CLAIM_BINDINGS = {
	claimId: "claim-id",
	now: 0,
	leaseCutoff: 0,
	sessionId: "session-a",
	identity: "beta",
};

const ACK_BINDINGS = {
	now: 0,
	sessionId: "session-a",
	claimId: "claim-id",
	identity: "beta",
};

const STORE_SOURCE = readFileSync(
	new URL("../../src/store/index.ts", import.meta.url),
	"utf8",
);

function storeSql(marker: string): string {
	const at = STORE_SOURCE.indexOf(marker);
	if (at < 0)
		throw new Error(`store source has no query containing "${marker}"`);
	const start = STORE_SOURCE.lastIndexOf("`", at) + 1;
	const end = STORE_SOURCE.indexOf("`", at);
	if (start === 0 || end < 0) throw new Error(`unterminated query "${marker}"`);
	const sql = STORE_SOURCE.slice(start, end);
	if (sql.includes("${")) {
		throw new Error(`query "${marker}" is interpolated — read it another way`);
	}
	return sql;
}

function migrated(): Database {
	const db = new Database(":memory:", { strict: true });
	for (const step of SCHEMA_STEPS) step.run(db);
	return db;
}

function plan(
	db: Database,
	sql: string,
	bindings: unknown[] | Record<string, unknown>,
): string {
	const statement = db.query(`EXPLAIN QUERY PLAN ${sql}`);
	const rows = (
		Array.isArray(bindings)
			? statement.all(...(bindings as never[]))
			: statement.all(bindings as never)
	) as { detail: string }[];
	return rows.map((row) => row.detail).join(" | ");
}

function claimPlan(db: Database, sql: string): string {
	return plan(db, sql, CLAIM_BINDINGS);
}

function ackPlan(db: Database, sql: string): string {
	return plan(db, sql, ACK_BINDINGS);
}

describe("hot-path query plans", () => {
	it("claimNext seeks the pending index instead of scanning messages", () => {
		const db = migrated();
		const detail = claimPlan(db, MESSAGE_CLAIM_SQL);

		expect(detail).toContain("USING INDEX idx_messages_pending");
		expect(detail).not.toContain("SCAN messages");
		db.close();
	});

	it("claimNextAgentMessage seeks the pending index instead of scanning agent_messages", () => {
		const db = migrated();
		const detail = claimPlan(db, AGENT_MESSAGE_CLAIM_SQL);

		expect(detail).toContain("USING INDEX idx_agent_messages_pending");
		expect(detail).not.toContain("SCAN agent_messages");
		db.close();
	});

	it("ackAgentMessage seeks the claim_id index instead of scanning agent_messages", () => {
		const db = migrated();
		const detail = ackPlan(db, AGENT_MESSAGE_ACK_SQL);

		expect(detail).toContain("USING INDEX idx_agent_messages_claim_id");
		expect(detail).not.toContain("SCAN agent_messages");
		db.close();
	});

	it("peekAll's history read seeks an index instead of scanning messages", () => {
		const db = migrated();
		const detail = plan(db, storeSql("SELECT seq, id, role, created_at"), [
			"session-a",
		]);

		expect(detail).toContain("USING INDEX idx_messages_session_seq");
		expect(detail).not.toContain("SCAN messages");
		db.close();
	});

	it("the per-session asset prune seeks an index instead of scanning assets", () => {
		const db = migrated();
		const detail = plan(db, storeSql("state = 'deleted'"), [0, "session-a"]);

		expect(detail).toContain("USING INDEX idx_assets_session_state");
		expect(detail).not.toContain("SCAN assets");
		db.close();
	});

	it("ack seeks the claim_id index instead of scanning the session's whole history", () => {
		const db = migrated();
		const detail = ackPlan(db, MESSAGE_ACK_SQL);

		expect(detail).toContain("USING INDEX idx_messages_claim_id");
		expect(detail).not.toContain("USING INDEX idx_messages_session_seq");
		db.close();
	});

	it("every index the hot paths rely on is created by a migration, not by hand", () => {
		const db = migrated();
		const names = (
			db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
				name: string;
			}[]
		).map((row) => row.name);

		expect(names).toContain("idx_messages_pending");
		expect(names).toContain("idx_messages_session_seq");
		expect(names).toContain("idx_assets_session_state");
		expect(names).toContain("idx_messages_claim_id");
		expect(names).toContain("idx_agent_messages_pending");
		expect(names).toContain("idx_agent_messages_claim_id");
		db.close();
	});

	it("a database created before v4 gains the indexes when it migrates up", () => {
		const db = new Database(":memory:", { strict: true });
		for (const step of SCHEMA_STEPS.filter((s) => s.version < 4)) step.run(db);
		expect(claimPlan(db, MESSAGE_CLAIM_SQL)).toContain("SCAN messages");

		for (const step of SCHEMA_STEPS.filter((s) => s.version === 4))
			step.run(db);

		expect(claimPlan(db, MESSAGE_CLAIM_SQL)).not.toContain("SCAN messages");
		db.close();
	});

	it("a database created before v5 resolves ack via the session index until it migrates up", () => {
		const db = new Database(":memory:", { strict: true });
		for (const step of SCHEMA_STEPS.filter((s) => s.version < 5)) step.run(db);
		const before = ackPlan(db, MESSAGE_ACK_SQL);
		expect(before).toContain("USING INDEX idx_messages_session_seq");
		expect(before).not.toContain("USING INDEX idx_messages_claim_id");

		for (const step of SCHEMA_STEPS.filter((s) => s.version === 5))
			step.run(db);

		expect(ackPlan(db, MESSAGE_ACK_SQL)).toContain(
			"USING INDEX idx_messages_claim_id",
		);
		db.close();
	});
});
