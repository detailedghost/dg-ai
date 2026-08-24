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
