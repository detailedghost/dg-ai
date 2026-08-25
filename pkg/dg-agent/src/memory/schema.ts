import type { Database } from "bun:sqlite";
import type { MigrationStep } from "@dg/common/node";

function createV1Memories(db: Database): void {
	db.run(`CREATE TABLE memories (
		id TEXT PRIMARY KEY,
		agent_identity TEXT NOT NULL,
		workset TEXT,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		body TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) STRICT`);

	db.run(
		"CREATE UNIQUE INDEX idx_memories_key ON memories(agent_identity, ifnull(workset, ''), title)",
	);
	db.run(
		"CREATE INDEX idx_memories_identity ON memories(agent_identity, updated_at DESC)",
	);
	db.run(
		"CREATE INDEX idx_memories_workset ON memories(workset, updated_at DESC) WHERE workset IS NOT NULL",
	);

	db.run(`CREATE VIRTUAL TABLE memories_fts USING fts5(
		title,
		body,
		content='memories',
		content_rowid='rowid'
	)`);

	db.run(`CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
		INSERT INTO memories_fts (rowid, title, body)
		VALUES (new.rowid, new.title, new.body);
	END`);
	db.run(`CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
		INSERT INTO memories_fts (memories_fts, rowid, title, body)
		VALUES ('delete', old.rowid, old.title, old.body);
		INSERT INTO memories_fts (rowid, title, body)
		VALUES (new.rowid, new.title, new.body);
	END`);
	db.run(`CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
		INSERT INTO memories_fts (memories_fts, rowid, title, body)
		VALUES ('delete', old.rowid, old.title, old.body);
	END`);
}

export const MEMORY_SCHEMA_STEPS: MigrationStep[] = [
	{ version: 1, run: createV1Memories },
];

export const CURRENT_MEMORY_SCHEMA_VERSION =
	MEMORY_SCHEMA_STEPS[MEMORY_SCHEMA_STEPS.length - 1].version;
