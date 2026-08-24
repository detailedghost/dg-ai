import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SCHEMA_STEPS } from "../../src/store/schema";

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

function plan(db: Database, sql: string, ...args: unknown[]): string {
	return (
		db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as {
			detail: string;
		}[]
	)
		.map((row) => row.detail)
		.join(" | ");
}

describe("hot-path query plans", () => {
	it("claimNext seeks the pending index instead of scanning messages", () => {
		const db = migrated();
		const detail = plan(
			db,
			storeSql("SET claim_id = ?, claimed_at = ?"),
			"claim-id",
			0,
			"session-a",
			0,
		);

		expect(detail).toContain("USING INDEX idx_messages_pending");
		expect(detail).not.toContain("SCAN messages");
		db.close();
	});

	it("peekAll's history read seeks an index instead of scanning messages", () => {
		const db = migrated();
		const detail = plan(
			db,
			storeSql("SELECT seq, id, role, created_at"),
			"session-a",
		);

		expect(detail).toContain("USING INDEX idx_messages_session_seq");
		expect(detail).not.toContain("SCAN messages");
		db.close();
	});

	it("the per-session asset prune seeks an index instead of scanning assets", () => {
		const db = migrated();
		const detail = plan(db, storeSql("state = 'deleted'"), 0, "session-a");

		expect(detail).toContain("USING INDEX idx_assets_session_state");
		expect(detail).not.toContain("SCAN assets");
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
		db.close();
	});

	it("a database created before v4 gains the indexes when it migrates up", () => {
		const db = new Database(":memory:", { strict: true });
		for (const step of SCHEMA_STEPS.filter((s) => s.version < 4)) step.run(db);
		const before = plan(
			db,
			storeSql("SET claim_id = ?, claimed_at = ?"),
			"claim-id",
			0,
			"session-a",
			0,
		);
		expect(before).toContain("SCAN messages");

		for (const step of SCHEMA_STEPS.filter((s) => s.version === 4))
			step.run(db);
		const after = plan(
			db,
			storeSql("SET claim_id = ?, claimed_at = ?"),
			"claim-id",
			0,
			"session-a",
			0,
		);
		expect(after).not.toContain("SCAN messages");
		db.close();
	});
});
