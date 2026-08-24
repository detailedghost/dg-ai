import type { Database } from "bun:sqlite";
import type { MigrationStep } from "./migrations";

function createV1Tables(db: Database): void {
	db.run(`CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		workset TEXT,
		role TEXT,
		created_at TEXT NOT NULL
	) STRICT`);

	db.run(`CREATE TABLE messages (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		role TEXT NOT NULL,
		created_at TEXT NOT NULL,
		body_ciphertext BLOB NOT NULL,
		body_iv BLOB NOT NULL,
		body_tag BLOB NOT NULL,
		attachment_id TEXT,
		claim_id TEXT,
		claimed_at INTEGER,
		delivered_at INTEGER
	) STRICT`);

	db.run(`CREATE TABLE status_events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		created_at TEXT NOT NULL,
		progress_ciphertext BLOB NOT NULL,
		progress_iv BLOB NOT NULL,
		progress_tag BLOB NOT NULL
	) STRICT`);

	db.run(`CREATE TABLE assets (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		created_at TEXT NOT NULL,
		filename_ciphertext BLOB NOT NULL,
		filename_iv BLOB NOT NULL,
		filename_tag BLOB NOT NULL,
		content_type TEXT NOT NULL,
		byte_length INTEGER NOT NULL,
		deleted_at TEXT,
		state TEXT NOT NULL
	) STRICT`);

	db.run(`CREATE TABLE command_invocations (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		created_at TEXT NOT NULL,
		argv_ciphertext BLOB NOT NULL,
		argv_iv BLOB NOT NULL,
		argv_tag BLOB NOT NULL,
		stdout_ciphertext BLOB NOT NULL,
		stdout_iv BLOB NOT NULL,
		stdout_tag BLOB NOT NULL,
		stderr_ciphertext BLOB NOT NULL,
		stderr_iv BLOB NOT NULL,
		stderr_tag BLOB NOT NULL,
		truncated INTEGER NOT NULL
	) STRICT`);

	db.run(`CREATE TABLE crypto_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		format_version INTEGER NOT NULL,
		key_id TEXT NOT NULL,
		key_source TEXT NOT NULL,
		wrapped_data_key BLOB NOT NULL
	) STRICT`);
}

function createV2Additions(db: Database): void {
	db.run(`ALTER TABLE messages ADD COLUMN subagent_name TEXT`);
	db.run(`ALTER TABLE command_invocations ADD COLUMN label TEXT`);
	db.run(`CREATE TABLE command_manifests (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id),
		updated_at TEXT NOT NULL,
		commands_ciphertext BLOB NOT NULL,
		commands_iv BLOB NOT NULL,
		commands_tag BLOB NOT NULL,
		subagents_ciphertext BLOB NOT NULL,
		subagents_iv BLOB NOT NULL,
		subagents_tag BLOB NOT NULL
	) STRICT`);
}

function createV3AssetStateCheck(db: Database): void {
	db.run(`CREATE TABLE assets_v3 (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		created_at TEXT NOT NULL,
		filename_ciphertext BLOB NOT NULL,
		filename_iv BLOB NOT NULL,
		filename_tag BLOB NOT NULL,
		content_type TEXT NOT NULL,
		byte_length INTEGER NOT NULL,
		deleted_at TEXT,
		state TEXT NOT NULL CHECK (state IN ('active', 'deleted'))
	) STRICT`);
	db.run(`INSERT INTO assets_v3 (
		id, session_id, created_at,
		filename_ciphertext, filename_iv, filename_tag,
		content_type, byte_length, deleted_at, state
	) SELECT
		id, session_id, created_at,
		filename_ciphertext, filename_iv, filename_tag,
		content_type, byte_length, deleted_at,
		CASE WHEN state IN ('active', 'deleted') THEN state ELSE 'deleted' END
	FROM assets`);
	db.run("DROP TABLE assets");
	db.run("ALTER TABLE assets_v3 RENAME TO assets");
}

function createV4Indexes(db: Database): void {
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(session_id, role, seq) WHERE delivered_at IS NULL",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_assets_session_state ON assets(session_id, state)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_status_events_session ON status_events(session_id, seq)",
	);
}

export const SCHEMA_STEPS: MigrationStep[] = [
	{ version: 1, run: createV1Tables },
	{ version: 2, run: createV2Additions },
	{ version: 3, run: createV3AssetStateCheck },
	{ version: 4, run: createV4Indexes },
];

export const CURRENT_SCHEMA_VERSION =
	SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version;
