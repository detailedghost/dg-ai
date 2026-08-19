/**
 * Hand-rolled PRAGMA user_version migrations: one BEGIN IMMEDIATE transaction
 * per step, version bump inside it, forward-only. PRAGMA user_version cannot
 * be parameterised (verified empirically) — the step's own numeric version is
 * validated as an integer before being interpolated as a literal.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type MigrationStep = { version: number; run: (db: Database) => void };

export type RunMigrationsOptions = { snapshotDir?: string };

export class ForwardOnlyVersionError extends Error {
	recordedVersion: number;
	supportedVersion: number;

	constructor(recordedVersion: number, supportedVersion: number) {
		super(
			`database schema user_version ${recordedVersion} is newer than this binary's supported version ${supportedVersion} — refusing to open a database written by a newer build`,
		);
		this.name = "ForwardOnlyVersionError";
		this.recordedVersion = recordedVersion;
		this.supportedVersion = supportedVersion;
	}
}

function readUserVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
}

function takeSnapshot(
	db: Database,
	snapshotDir: string,
	version: number,
): void {
	mkdirSync(snapshotDir, { recursive: true });
	const target = join(
		snapshotDir,
		`pre-migration-v${version}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
	);
	// VACUUM INTO cannot run inside a transaction — taken before BEGIN below.
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
		// Re-read inside the transaction: a concurrent writer may have already
		// advanced user_version between our outer read and this BEGIN.
		if (step.version <= readUserVersion(db)) {
			db.run("COMMIT");
			return;
		}
		step.run(db);
		db.run(`PRAGMA user_version = ${step.version}`);
		db.run("COMMIT");
	} catch (err) {
		try {
			db.run("ROLLBACK");
		} catch {
			// best-effort — some failure modes have already rolled back themselves
		}
		throw err;
	}
}

/** Runs every step whose version exceeds the db's current user_version, in order. */
export function runMigrations(
	db: Database,
	steps: MigrationStep[],
	options: RunMigrationsOptions = {},
): void {
	const supportedVersion =
		steps.length > 0 ? steps[steps.length - 1].version : 0;
	const currentVersion = readUserVersion(db);

	if (currentVersion > supportedVersion) {
		throw new ForwardOnlyVersionError(currentVersion, supportedVersion);
	}

	for (const step of steps) {
		if (step.version <= readUserVersion(db)) continue;
		runStep(db, step, options.snapshotDir);
	}
}
