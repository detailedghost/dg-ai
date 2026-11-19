import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function applyConnectionPragmas(
	db: Database,
	busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): void {
	db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	const pause = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + busyTimeoutMs;
	for (;;) {
		try {
			db.run("PRAGMA journal_mode = WAL");
			break;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) ||
				error.code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
			Atomics.wait(pause, 0, 0, 10);
		}
	}
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA foreign_keys = ON");
}

export type MigrationStep = { version: number; run: (db: Database) => void };

export type RunMigrationsOptions = { snapshotDir?: string };

export class ForwardOnlyVersionError extends Error {
	readonly recordedVersion: number;
	readonly supportedVersion: number;

	constructor(recordedVersion: number, supportedVersion: number) {
		super(
			`database schema user_version ${recordedVersion} is newer than this binary's supported version ${supportedVersion} — refusing to open a database written by a newer build`,
		);
		this.name = "ForwardOnlyVersionError";
		this.recordedVersion = recordedVersion;
		this.supportedVersion = supportedVersion;
	}
}

export function readSchemaVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
}

const snapshotPrefix = (version: number): string => `pre-migration-v${version}-`;

/** Removes the pre-migration snapshots of `version` and their sidecar files; returns the names. */
export function removeSchemaSnapshots(dir: string, version: number): string[] {
	const prefix = snapshotPrefix(version);
	const names = readdirSync(dir).filter(
		(name) => name.startsWith(prefix) && /\.db(-wal|-shm|-journal)?$/.test(name),
	);
	for (const name of names) rmSync(join(dir, name), { force: true });
	return names;
}

function takeSnapshot(
	db: Database,
	snapshotDir: string,
	version: number,
): void {
	mkdirSync(snapshotDir, { recursive: true });
	const target = join(
		snapshotDir,
		`${snapshotPrefix(version)}${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
	);
	db.run(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

function runStep(
	db: Database,
	step: MigrationStep,
	snapshotDir?: string,
): void {
	if (snapshotDir) takeSnapshot(db, snapshotDir, step.version);
	if (!Number.isInteger(step.version) || step.version < 0) {
		throw new Error(`invalid migration step version: ${step.version}`);
	}

	db.run("BEGIN IMMEDIATE");
	try {
		if (step.version <= readSchemaVersion(db)) {
			db.run("COMMIT");
			return;
		}
		step.run(db);
		db.run(`PRAGMA user_version = ${step.version}`);
		db.run("COMMIT");
	} catch (err) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw err;
	}
}

export function runMigrations(
	db: Database,
	steps: MigrationStep[],
	options: RunMigrationsOptions = {},
): void {
	const supportedVersion =
		steps.length > 0 ? steps[steps.length - 1].version : 0;
	const currentVersion = readSchemaVersion(db);

	if (currentVersion > supportedVersion) {
		throw new ForwardOnlyVersionError(currentVersion, supportedVersion);
	}

	for (const step of steps) {
		if (step.version <= readSchemaVersion(db)) continue;
		runStep(db, step, options.snapshotDir);
	}
}
