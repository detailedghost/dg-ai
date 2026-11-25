import { Database } from "bun:sqlite";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, writeFileAtomic } from "./fs";
import type { DgPaths } from "./dg-paths";
import { applyConnectionPragmas, readSchemaVersion, runMigrations } from "./sqlite";
import { SCHEMA_STEPS } from "./daemon-schema";

export {
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
			`dg daemon: daemon directory ${daemonDir} had mode ${mode.toString(8)} (expected 0700) — fixing; a permissive directory may have exposed the database or -wal sidecar`,
		);
		chmodSync(daemonDir, 0o700);
	}
}

type JsonObject = Record<string, unknown>;
type HandledEntry = { status?: unknown; at?: unknown; chatId?: unknown };

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const objectOr = (value: unknown): JsonObject => (isObject(value) ? value : {});

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function importFileOf(state: JsonObject): JsonObject {
	const handled = Object.entries(objectOr(state.handled) as Record<string, HandledEntry>)
		.map(([messageId, { status, at, chatId }]) => ({
			messageId,
			status,
			at,
			...(chatId === undefined ? {} : { chatId }),
		}))
		.sort((x, y) => byText(String(x.at), String(y.at)) || byText(x.messageId, y.messageId));
	return {
		version: 1,
		cursor: objectOr(state.lastEventIds),
		handled,
		current: isObject(state.current) ? state.current : null,
		automation: {
			blocked: objectOr(state.blocked),
			issues: objectOr(state.issues),
			sinks: objectOr(state.sinks),
			prWatch: objectOr(state.prWatch),
			deps: { lastRun: objectOr(objectOr(state.deps).lastRun) },
		},
	};
}

/** Writes each channel-review state row as an import file beside daemon.db before the step that drops it. */
function copyChannelReviewState(db: Database, daemonDir: string): void {
	const rows = db.transaction(() => {
		const version = readSchemaVersion(db);
		if (version < 12 || version > 14) return [];
		const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_review_state'").get();
		if (!table) return [];
		return db.query("SELECT env, state_json FROM channel_review_state ORDER BY env").all() as {
			env: string;
			state_json: string;
		}[];
	})();
	for (const { env, state_json } of rows) {
		const target = join(daemonDir, `channel-review-state.${env}.json`);
		try {
			const file = importFileOf(objectOr(JSON.parse(state_json)));
			writeFileAtomic(target, `${JSON.stringify(file, null, "\t")}\n`, 0o600);
		} catch (error) {
			throw new Error(`cannot write the channel-review state copy ${target}: ${(error as Error).message}`);
		}
	}
}

/** Opens the shared schema only. ChatStore alone owns crypto_meta/key initialization. */
export function openDaemonDatabase(paths: Pick<DgPaths, "dbPath" | "daemonDir">): Database {
	ensureDaemonDir(paths.daemonDir);
	const db = new Database(paths.dbPath, { strict: true, create: true, readwrite: true });
	try {
		applyConnectionPragmas(db);
		copyChannelReviewState(db, paths.daemonDir);
		runMigrations(db, SCHEMA_STEPS,
			readSchemaVersion(db) > 0 ? { snapshotDir: paths.daemonDir } : {});
		return db;
	} catch (error) {
		db.close(false);
		throw error;
	}
}
