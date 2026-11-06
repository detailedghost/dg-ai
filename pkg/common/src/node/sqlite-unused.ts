import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const JOURNAL_MODE_BYTES = { start: 18, end: 20, rollback: 1 } as const;
const UNUSED_DB_MAX_BYTES = 1024 * 1024;

const nonEmpty = (path: string): boolean => {
	try {
		return statSync(path).size > 0;
	} catch {
		return false;
	}
};

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** True when every table of the db is empty; it reads a copy in memory, so no -wal or -shm file appears. */
export function sqliteUnused(dbFile: string): boolean {
	if (nonEmpty(`${dbFile}-wal`)) return false;
	let db: Database | undefined;
	try {
		if (statSync(dbFile).size > UNUSED_DB_MAX_BYTES) return false;
		const bytes = readFileSync(dbFile);
		bytes.fill(JOURNAL_MODE_BYTES.rollback, JOURNAL_MODE_BYTES.start, JOURNAL_MODE_BYTES.end);
		db = Database.deserialize(bytes, true);
		const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
		return tables.every(({ name }) => db?.query(`SELECT 1 FROM ${quoted(name)} LIMIT 1`).get() === null);
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

/** True when the folder is empty, or holds only `<dbName>*` files whose db is unused. */
export function folderUnused(dir: string, dbName?: string): boolean {
	try {
		const names = readdirSync(dir);
		if (names.length === 0) return true;
		return dbName !== undefined && names.every((name) => name.startsWith(dbName)) && sqliteUnused(join(dir, dbName));
	} catch {
		return false;
	}
}
