
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ForwardOnlyVersionError,
	type MigrationStep,
	runMigrations,
} from "../../src/store/migrations";

function tempDbPath(): string {
	return join(mkdtempSync(join(tmpdir(), "dg-migrations-test-")), "test.db");
}

function openDb(path: string): Database {
	return new Database(path, { strict: true, create: true, readwrite: true });
}

const stepCreateA: MigrationStep = {
	version: 1,
	run: (db) => db.run("CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT) STRICT"),
};

const stepCreateB: MigrationStep = {
	version: 2,
	run: (db) => db.run("CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT) STRICT"),
};

describe("runMigrations", () => {
	it("initializes a fresh database (user_version 0) at the current version, running every step", () => {
		const db = openDb(tempDbPath());
		runMigrations(db, [stepCreateA, stepCreateB]);

		const version = (
			db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(version).toBe(2);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE name IN ('a','b')").all()
				.length,
		).toBe(2);
		db.close(true);
	});

	it("migrates an older database forward, preserving its existing rows", () => {
		const path = tempDbPath();
		const first = openDb(path);
		runMigrations(first, [stepCreateA]);
		first.run("INSERT INTO a (v) VALUES ('kept-row')");
		first.close(true);

		const second = openDb(path);
		runMigrations(second, [stepCreateA, stepCreateB]);

		const version = (
			second.query("PRAGMA user_version").get() as {
				user_version: number;
			}
		).user_version;
		expect(version).toBe(2);
		expect(second.query("SELECT v FROM a").all()).toEqual([{ v: "kept-row" }]);
		expect(
			second.query("SELECT name FROM sqlite_master WHERE name = 'b'").get(),
		).not.toBeNull();
		second.close(true);
	});

	it("refuses a database whose user_version exceeds the binary's supported version, naming both", () => {
		const db = openDb(tempDbPath());
		db.run("PRAGMA user_version = 99");

		let thrown: unknown;
		try {
			runMigrations(db, [stepCreateA, stepCreateB]);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(ForwardOnlyVersionError);
		const refusal = thrown as ForwardOnlyVersionError;
		expect(refusal.recordedVersion).toBe(99);
		expect(refusal.supportedVersion).toBe(2);
		expect(refusal.message).not.toMatch(/protocol/i);
		expect(refusal.message).toMatch(/version/i);
	});

	it("leaves user_version at the last completed step when a later step throws mid-migration, and does not leave the db locked", () => {
		const path = tempDbPath();
		const db = openDb(path);
		const throwingStep: MigrationStep = {
			version: 2,
			run: (innerDb) => {
				innerDb.run("CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT");
				throw new Error("boom mid-step");
			},
		};

		expect(() => runMigrations(db, [stepCreateA, throwingStep])).toThrow(
			"boom mid-step",
		);

		const reopened = openDb(path);
		const version = (
			reopened.query("PRAGMA user_version").get() as {
				user_version: number;
			}
		).user_version;
		expect(version).toBe(1);
		expect(
			reopened.query("SELECT name FROM sqlite_master WHERE name = 'b'").get(),
		).toBeNull();
		expect(() =>
			reopened.run("INSERT INTO a (v) VALUES ('after-failure')"),
		).not.toThrow();
		reopened.close(true);
	});

	it("takes a VACUUM INTO snapshot into snapshotDir before running a migration step", () => {
		const path = tempDbPath();
		const db = openDb(path);
		const snapshotDir = mkdtempSync(join(tmpdir(), "dg-migrations-snapshot-"));

		runMigrations(db, [stepCreateA], { snapshotDir });

		expect(readdirSync(snapshotDir).length).toBeGreaterThan(0);
		db.close(true);
	});
});
