/**
 * Per-connection pragma setup. foreign_keys and busy_timeout are NOT
 * persisted to the database file — they reset to 0 on every fresh connection
 * regardless of what another connection set (verified empirically) — so this
 * runs once per Database instance, outside any transaction.
 */
import type { Database } from "bun:sqlite";

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function applyConnectionPragmas(
	db: Database,
	busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): void {
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
}
