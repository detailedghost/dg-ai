import type { Database } from "bun:sqlite";
import type { MigrationStep } from "@dg/common/node";

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

function createV5AckIndex(db: Database): void {
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_messages_claim_id ON messages(claim_id) WHERE claim_id IS NOT NULL",
	);
}

function createV6AgentMessages(db: Database): void {
	db.run(`CREATE TABLE agent_messages (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		sender_session_id TEXT NOT NULL REFERENCES sessions(id),
		sender_identity TEXT NOT NULL,
		recipient_identity TEXT NOT NULL,
		created_at TEXT NOT NULL,
		body_ciphertext BLOB NOT NULL,
		body_iv BLOB NOT NULL,
		body_tag BLOB NOT NULL,
		claim_id TEXT,
		claimed_at INTEGER,
		delivered_at INTEGER
	) STRICT`);

	db.run(
		"CREATE INDEX idx_agent_messages_pending ON agent_messages(recipient_identity, seq) WHERE delivered_at IS NULL",
	);
	db.run(
		"CREATE INDEX idx_agent_messages_claim_id ON agent_messages(claim_id) WHERE claim_id IS NOT NULL",
	);
}

function createV7ScheduledJobs(db: Database): void {
	db.run(`CREATE TABLE scheduled_jobs (
		id TEXT PRIMARY KEY,
		label TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		argv_ciphertext BLOB NOT NULL,
		argv_iv BLOB NOT NULL,
		argv_tag BLOB NOT NULL,
		cwd TEXT NOT NULL,
		interval_ms INTEGER NOT NULL,
		enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
		notify_identity TEXT,
		last_run_at TEXT,
		next_run_at TEXT NOT NULL,
		last_exit_code INTEGER,
		last_error_ciphertext BLOB,
		last_error_iv BLOB,
		last_error_tag BLOB
	) STRICT`);

	db.run(`CREATE TABLE feed_items (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
		fingerprint TEXT NOT NULL,
		created_at TEXT NOT NULL,
		title_ciphertext BLOB NOT NULL,
		title_iv BLOB NOT NULL,
		title_tag BLOB NOT NULL,
		meta_ciphertext BLOB,
		meta_iv BLOB,
		meta_tag BLOB,
		url_ciphertext BLOB,
		url_iv BLOB,
		url_tag BLOB,
		read_at TEXT
	) STRICT`);

	db.run(
		"CREATE UNIQUE INDEX idx_feed_items_dedupe ON feed_items(job_id, fingerprint)",
	);
	db.run(
		"CREATE INDEX idx_feed_items_unread ON feed_items(job_id, seq) WHERE read_at IS NULL",
	);
	db.run("CREATE INDEX idx_feed_items_recent ON feed_items(seq)");
	db.run(
		"CREATE INDEX idx_scheduled_jobs_due ON scheduled_jobs(next_run_at) WHERE enabled = 1",
	);
}

export const SCHEMA_STEPS: MigrationStep[] = [
	{ version: 1, run: createV1Tables },
	{ version: 2, run: createV2Additions },
	{ version: 3, run: createV3AssetStateCheck },
	{ version: 4, run: createV4Indexes },
	{ version: 5, run: createV5AckIndex },
	{ version: 6, run: createV6AgentMessages },
	{ version: 7, run: createV7ScheduledJobs },
];

export const CURRENT_SCHEMA_VERSION =
	SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version;
