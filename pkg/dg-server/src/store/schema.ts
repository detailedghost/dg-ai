/**
 * v1 schema: every table STRICT, messages/status_events/command_invocations
 * keyed by an AUTOINCREMENT seq (timestamps are neither unique nor
 * monotonic), assets carrying deleted_at + state so a pruned asset is a
 * known-gone row rather than a missing one.
 */
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

export const SCHEMA_STEPS: MigrationStep[] = [
	{ version: 1, run: createV1Tables },
];

export const CURRENT_SCHEMA_VERSION =
	SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version;
