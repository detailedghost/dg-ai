import { Database } from "bun:sqlite";
import { chmodSync, existsSync, statSync } from "node:fs";
import { ensurePrivateDir } from "./fs";
import type { DgPaths } from "./paths";
import { applyConnectionPragmas, readSchemaVersion, runMigrations } from "./sqlite";
import { SCHEMA_STEPS } from "./daemon-schema";

export {
	CHANNEL_REVIEW_SCHEMA_VERSION,
	CURRENT_SCHEMA_VERSION,
	SCHEMA_STEPS,
} from "./daemon-schema";

function ensureDaemonDir(daemonDir: string): void {
	if (!existsSync(daemonDir)) {
		ensurePrivateDir(daemonDir);
		return;
	}
	const mode = statSync(daemonDir).mode & 0o777;
	if (mode !== 0o700) {
		console.warn(
			`dg-daemon: daemon directory ${daemonDir} had mode ${mode.toString(8)} (expected 0700) — fixing; a permissive directory may have exposed the database or -wal sidecar`,
		);
		chmodSync(daemonDir, 0o700);
	}
}

/** Opens the shared schema only. ChatStore alone owns crypto_meta/key initialization. */
export function openDaemonDatabase(paths: Pick<DgPaths, "dbPath" | "daemonDir">): Database {
	ensureDaemonDir(paths.daemonDir);
	const db = new Database(paths.dbPath, { strict: true, create: true, readwrite: true });
	try {
		applyConnectionPragmas(db);
		runMigrations(db, SCHEMA_STEPS,
			readSchemaVersion(db) > 0 ? { snapshotDir: paths.daemonDir } : {});
		return db;
	} catch (error) {
		db.close(false);
		throw error;
	}
}
