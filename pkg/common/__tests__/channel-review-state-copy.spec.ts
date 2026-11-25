import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, openDaemonDatabase, SCHEMA_STEPS } from "@dg/common/daemon-db";
import { ForwardOnlyVersionError, readSchemaVersion, resolveDgPaths, runMigrations } from "@dg/common/node";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function freshPaths() {
	const home = mkdtempSync(join(tmpdir(), "dg-cr-copy-"));
	homes.push(home);
	return resolveDgPaths({ env: { DG_HOME: home } });
}

type Paths = ReturnType<typeof freshPaths>;

function oldDatabase(paths: Paths, version: number): Database {
	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	const db = new Database(paths.dbPath, { strict: true, create: true });
	runMigrations(db, SCHEMA_STEPS.filter((step) => step.version <= version));
	return db;
}

function insertState(db: Database, env: string, state: unknown, revision: number, updatedAt: string): void {
	db.run("INSERT INTO channel_review_state (env, state_json, revision, updated_at) VALUES (?, ?, ?, ?)", [
		env,
		JSON.stringify(state),
		revision,
		updatedAt,
	]);
}

function channelReviewObjects(db: Database): string[] {
	return (db.query("SELECT name FROM sqlite_master WHERE name LIKE 'channel_review%'").all() as { name: string }[]).map(
		(row) => row.name,
	);
}

function copyPath(paths: Paths, env: string): string {
	return join(paths.daemonDir, `channel-review-state.${env}.json`);
}

function readCopy(paths: Paths, env: string): unknown {
	return JSON.parse(readFileSync(copyPath(paths, env), "utf8"));
}

function copyFiles(paths: Paths): string[] {
	return readdirSync(paths.daemonDir).filter((name) => name.startsWith("channel-review-state."));
}

const devState = {
	lastEventIds: { "chat-1": "event-9" },
	current: { messageId: "m-3", chatId: "chat-1", url: "https://example.test/pr/3", number: 3, startedAt: "2026-11-01T00:03:00.000Z", pid: 41, pidStart: "x" },
	running: { "m-3": { messageId: "m-3", chatId: "chat-1", url: "https://example.test/pr/3", number: 3, startedAt: "2026-11-01T00:03:00.000Z" } },
	handled: {
		"m-2": { status: "done", at: "2026-11-01T00:02:00.000Z" },
		"m-1": { status: "failed", at: "2026-11-01T00:02:00.000Z", chatId: "chat-1" },
		"m-0": { status: "done", at: "2026-11-01T00:01:00.000Z", chatId: "chat-1" },
	},
	blocked: { "https://example.test/pr/1": { messageId: "m-1" } },
	issues: { "issue-1": { at: "2026-11-01T00:00:00.000Z" } },
	sinks: { slack: { lastError: "boom" } },
	fixStarts: ["2026-11-01T00:00:00.000Z"],
	deps: { lastRun: { "repo-a": { at: "2026-11-01T00:00:00.000Z" } } },
	prWatch: { "https://example.test/pr/2": { startedAt: "2026-11-01T00:00:00.000Z" } },
};

describe("channel-review state copy at the drop step", () => {
	test("writes one import-shaped copy for each env with mode 0600 and drops the channel-review objects", () => {
		const paths = freshPaths();
		const old = oldDatabase(paths, CURRENT_SCHEMA_VERSION - 1);
		insertState(old, "dev", devState, 7, "2026-11-02T00:00:00.000Z");
		insertState(old, "prod", { lastEventIds: { "chat-2": "event-1" } }, 1, "2026-11-03T00:00:00.000Z");
		old.run("INSERT INTO sessions (id, created_at) VALUES (?, ?)", ["session-kept", "2026-01-01T00:00:00.000Z"]);
		const counts = old.query("SELECT count(*) AS n FROM sessions").get();
		old.close(true);

		const db = openDaemonDatabase(paths);
		expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(channelReviewObjects(db)).toEqual([]);
		expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual(counts);
		db.close(true);

		expect(copyFiles(paths).sort()).toEqual(["channel-review-state.dev.json", "channel-review-state.prod.json"]);
		if (process.platform !== "win32") {
			expect(statSync(copyPath(paths, "dev")).mode & 0o777).toBe(0o600);
			expect(statSync(copyPath(paths, "prod")).mode & 0o777).toBe(0o600);
		}
		expect(readCopy(paths, "dev")).toEqual({
			version: 1,
			cursor: devState.lastEventIds,
			handled: [
				{ messageId: "m-0", status: "done", at: "2026-11-01T00:01:00.000Z", chatId: "chat-1" },
				{ messageId: "m-1", status: "failed", at: "2026-11-01T00:02:00.000Z", chatId: "chat-1" },
				{ messageId: "m-2", status: "done", at: "2026-11-01T00:02:00.000Z" },
			],
			current: devState.current,
			automation: {
				blocked: devState.blocked,
				issues: devState.issues,
				sinks: devState.sinks,
				prWatch: devState.prWatch,
				deps: devState.deps,
			},
		});
	});

	test("keeps the import key order and fills the defaults of an older state shape", () => {
		const paths = freshPaths();
		const old = oldDatabase(paths, CURRENT_SCHEMA_VERSION - 1);
		insertState(old, "prod", { lastEventIds: { "chat-2": "event-1" } }, 1, "2026-11-03T00:00:00.000Z");
		old.close(true);
		openDaemonDatabase(paths).close(true);

		const copy = readCopy(paths, "prod") as Record<string, unknown>;
		expect(Object.keys(copy)).toEqual(["version", "cursor", "handled", "current", "automation"]);
		expect(Object.keys(copy.automation as object)).toEqual(["blocked", "issues", "sinks", "prWatch", "deps"]);
		expect(copy).toEqual({
			version: 1,
			cursor: { "chat-2": "event-1" },
			handled: [],
			current: null,
			automation: { blocked: {}, issues: {}, sinks: {}, prWatch: {}, deps: { lastRun: {} } },
		});
		expect(JSON.stringify(copy)).not.toContain("fixStarts");
		expect(JSON.stringify(copy)).not.toContain("running");
	});

	test("moves a database at version 13 through 14 to the current version with a copy", () => {
		const paths = freshPaths();
		const old = oldDatabase(paths, 13);
		insertState(old, "dev", devState, 2, "2026-11-02T00:00:00.000Z");
		old.close(true);

		const db = openDaemonDatabase(paths);
		expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(channelReviewObjects(db)).toEqual([]);
		db.close(true);
		expect(copyFiles(paths)).toEqual(["channel-review-state.dev.json"]);
	});

	test("moves a database at version 11 to the current version with no copy and no error", () => {
		const paths = freshPaths();
		oldDatabase(paths, 11).close(true);

		const db = openDaemonDatabase(paths);
		expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(channelReviewObjects(db)).toEqual([]);
		db.close(true);
		expect(copyFiles(paths)).toEqual([]);
	});

	test("writes no copy for a new database or a database with no state row", () => {
		const fresh = freshPaths();
		openDaemonDatabase(fresh).close(true);
		expect(copyFiles(fresh)).toEqual([]);

		const empty = freshPaths();
		oldDatabase(empty, CURRENT_SCHEMA_VERSION - 1).close(true);
		openDaemonDatabase(empty).close(true);
		expect(copyFiles(empty)).toEqual([]);
	});

	test("a second open at the current version writes no file and leaves the copy unchanged", () => {
		const paths = freshPaths();
		const old = oldDatabase(paths, CURRENT_SCHEMA_VERSION - 1);
		insertState(old, "dev", devState, 7, "2026-11-02T00:00:00.000Z");
		old.close(true);
		openDaemonDatabase(paths).close(true);
		const before = readFileSync(copyPath(paths, "dev"), "utf8");
		const mtime = statSync(copyPath(paths, "dev")).mtimeMs;

		openDaemonDatabase(paths).close(true);
		expect(readFileSync(copyPath(paths, "dev"), "utf8")).toBe(before);
		expect(statSync(copyPath(paths, "dev")).mtimeMs).toBe(mtime);
		expect(copyFiles(paths)).toEqual(["channel-review-state.dev.json"]);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"fails the open with the copy path when the copy cannot be written and keeps the row",
		() => {
			const paths = freshPaths();
			const old = oldDatabase(paths, CURRENT_SCHEMA_VERSION - 1);
			insertState(old, "dev", devState, 7, "2026-11-02T00:00:00.000Z");
			old.close(true);
			mkdirSync(copyPath(paths, "dev"));

			expect(() => openDaemonDatabase(paths)).toThrow(copyPath(paths, "dev"));
			const raw = new Database(paths.dbPath, { readonly: true });
			expect(readSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION - 1);
			expect(raw.query("SELECT count(*) AS n FROM channel_review_state").get()).toEqual({ n: 1 });
			raw.close(true);
		},
	);

	test("two opens at the same time give one set of copies and one migration", async () => {
		const paths = freshPaths();
		const old = oldDatabase(paths, CURRENT_SCHEMA_VERSION - 1);
		insertState(old, "dev", devState, 7, "2026-11-02T00:00:00.000Z");
		insertState(old, "prod", { lastEventIds: {} }, 1, "2026-11-03T00:00:00.000Z");
		old.close(true);
		const module = new URL("../src/node/daemon-db.ts", import.meta.url).pathname;
		const script = `import { openDaemonDatabase } from ${JSON.stringify(module)};
			openDaemonDatabase(JSON.parse(process.argv[1])).close(true);`;
		const children = Array.from({ length: 2 }, () =>
			Bun.spawn([process.execPath, "-e", script, JSON.stringify(paths)], { stdout: "pipe", stderr: "pipe" }),
		);
		const results = await Promise.all(
			children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
		);
		expect(results).toEqual(children.map(() => ({ code: 0, stderr: "" })));
		const raw = new Database(paths.dbPath, { readonly: true });
		expect(readSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
		expect(channelReviewObjects(raw)).toEqual([]);
		raw.close(true);
		expect(copyFiles(paths).sort()).toEqual(["channel-review-state.dev.json", "channel-review-state.prod.json"]);
		expect((readCopy(paths, "dev") as { cursor: unknown }).cursor).toEqual(devState.lastEventIds);
	});

	test("a release before the drop step refuses a database at the current version", () => {
		const paths = freshPaths();
		const db = openDaemonDatabase(paths);
		expect(() => runMigrations(db, SCHEMA_STEPS.slice(0, -1))).toThrow(ForwardOnlyVersionError);
		db.close(true);
	});

	test("the first open leaves the pid file of the old channel-review daemon as it was", () => {
		const paths = freshPaths();
		const old = oldDatabase(paths, CURRENT_SCHEMA_VERSION - 1);
		insertState(old, "dev", devState, 7, "2026-11-02T00:00:00.000Z");
		old.close(true);
		const pidDir = join(paths.stateDir, "channel-review");
		mkdirSync(pidDir, { recursive: true });
		const pidFile = join(pidDir, "daemon.dev.pid");
		writeFileSync(pidFile, "{\"pid\":1}");
		const before = statSync(pidFile).mtimeMs;

		openDaemonDatabase(paths).close(true);
		expect(readFileSync(pidFile, "utf8")).toBe("{\"pid\":1}");
		expect(statSync(pidFile).mtimeMs).toBe(before);
	});
});
