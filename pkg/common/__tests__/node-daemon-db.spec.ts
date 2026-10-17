import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, openDaemonDatabase, SCHEMA_STEPS } from "@dg/common/daemon-db";
import { ForwardOnlyVersionError, readSchemaVersion, resolveDgPaths, runMigrations } from "@dg/common/node";

const homes: string[] = [];
function freshPaths() {
	const home = mkdtempSync(join(tmpdir(), "dg-shared-db-"));
	homes.push(home);
	return resolveDgPaths({ env: { DG_HOME: home } });
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("openDaemonDatabase", () => {
	test("initializes the full central schema without minting keys or credentials", () => {
		const paths = freshPaths();
		const db = openDaemonDatabase(paths);
		expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(db.query("SELECT count(*) AS n FROM crypto_meta").get()).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM inbox_auth_caches").get()).toEqual({ n: 0 });
		db.close(true);
		expect(existsSync(paths.keyPath)).toBe(false);
		expect(existsSync(paths.credentialsDbPath)).toBe(false);
	});

	test("rolls back a failed schema-12 migration and retries after repairing the conflict", () => {
		const paths = freshPaths();
		mkdirSync(paths.daemonDir, { recursive: true });
		const db = new Database(paths.dbPath, { strict: true, create: true });
		runMigrations(db, SCHEMA_STEPS.filter(step => step.version <= 11));
		db.run("CREATE VIEW channel_review_current AS SELECT 'conflict' AS value");
		expect(() => openDaemonDatabase(paths)).toThrow("already exists");
		expect(readSchemaVersion(db)).toBe(11);
		expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('channel_review_state', 'channel_review_requests')").all()).toEqual([]);
		db.run("DROP VIEW channel_review_current");
		db.close(true);
		const retry = openDaemonDatabase(paths);
		expect(readSchemaVersion(retry)).toBe(CURRENT_SCHEMA_VERSION);
		expect(retry.query("SELECT count(*) AS n FROM channel_review_requests").get()).toEqual({ n: 0 });
		retry.close(true);
	});

	test("refuses a forward database without changing its version", () => {
		const paths = freshPaths();
		const db = openDaemonDatabase(paths);
		db.run(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
		db.close(true);
		expect(() => openDaemonDatabase(paths)).toThrow(ForwardOnlyVersionError);
		const raw = new Database(paths.dbPath, { readonly: true });
		expect(readSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION + 1);
		raw.close(true);
	});

	test("serializes simultaneous first-open schema initialization across processes", async () => {
		const paths = freshPaths();
		const module = new URL("../src/node/daemon-db.ts", import.meta.url).pathname;
		const script = `import { openDaemonDatabase } from ${JSON.stringify(module)};
			const db = openDaemonDatabase(JSON.parse(process.argv[1]));
			db.close(true);`;
		const children = Array.from({ length: 4 }, () => Bun.spawn(
			[process.execPath, "-e", script, JSON.stringify(paths)], { stdout: "pipe", stderr: "pipe" }));
		const results = await Promise.all(children.map(async (child) => ({
			code: await child.exited, stderr: await new Response(child.stderr).text(),
		})));
		expect(results).toEqual(children.map(() => ({ code: 0, stderr: "" })));
		const raw = new Database(paths.dbPath, { readonly: true });
		expect(readSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
		expect(raw.query("SELECT count(*) AS n FROM channel_review_state").get()).toEqual({ n: 0 });
		raw.close(true);
	});
});
