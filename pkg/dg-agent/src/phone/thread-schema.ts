import type { Database } from "bun:sqlite";

function tableExists(db: Database, name: string): boolean {
	const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name").get({ name });
	return row !== null;
}

function columnExists(db: Database, table: string, column: string): boolean {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.some((row) => row.name === column);
}

/**
 * Adds thread tables and `messages.thread_id`. Safe to run more than once:
 * each create checks sqlite_master, and the column add checks table_info.
 * One-to-one rows stay valid because `thread_id` is nullable.
 */
export function migrateThreadSchema(db: Database): void {
	if (!tableExists(db, "threads")) {
		db.run(`CREATE TABLE threads (
			id TEXT PRIMARY KEY,
			handle TEXT NOT NULL UNIQUE,
			subject TEXT NOT NULL,
			key_id TEXT NOT NULL REFERENCES keys(id),
			created_at INTEGER NOT NULL,
			via TEXT NOT NULL
		) STRICT`);
	}
	if (!tableExists(db, "thread_members")) {
		db.run(`CREATE TABLE thread_members (
			thread_id TEXT NOT NULL REFERENCES threads(id),
			npub TEXT NOT NULL,
			PRIMARY KEY (thread_id, npub)
		) STRICT`);
	}
	if (!tableExists(db, "pending_threads")) {
		db.run(`CREATE TABLE pending_threads (
			rumor_id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			sender TEXT NOT NULL,
			members TEXT NOT NULL,
			subject TEXT,
			text TEXT NOT NULL,
			ts INTEGER NOT NULL,
			noticed INTEGER NOT NULL DEFAULT 0
		) STRICT`);
	}
	if (!columnExists(db, "messages", "thread_id")) {
		db.run("ALTER TABLE messages ADD COLUMN thread_id TEXT REFERENCES threads(id)");
	}
	db.run("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)");
}
