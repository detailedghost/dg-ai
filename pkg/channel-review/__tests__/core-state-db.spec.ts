import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDaemonDatabase } from "@dg/common/daemon-db";
import { channelReviewPaths, type ChannelReviewPaths } from "../src/paths";
import { createStateStore, readStateSnapshot, type StateStore, type ChannelState } from "../src/state";
import { createTempHome, type TempHome } from "./support/fakes";

let home: TempHome;
let paths: ChannelReviewPaths;
const stores: StateStore[] = [];
beforeEach(() => {
	home = createTempHome();
	paths = channelReviewPaths("dev", { env: home.env });
	mkdirSync(dirname(paths.statePath), { recursive: true });
});
afterEach(() => { for (const store of stores.splice(0)) store.close(); home.cleanup(); });
const open = (location = paths) => { const store = createStateStore(location); stores.push(store); return store; };
const rawDb = () => new Database(paths.dbPath, { strict: true, readwrite: true });
const seed = (state: unknown, location = paths) => writeFileSync(location.statePath, JSON.stringify(state));
const at = "2026-10-14T12:00:00.000Z";

function legacyState(): ChannelState {
	return {
		lastEventIds: { chat1: "cursor-1", chat2: "cursor-2" },
		current: { messageId: "running", chatId: "chat2", url: "https://github.com/example/app/pull/1", number: 1, startedAt: at, pid: 1234, pidStart: "process-start" },
		handled: Object.fromEntries((["pending", "running", "done", "failed"] as const).map(status => [status, { status, at, chatId: "chat2" }])),
		blocked: { pr: { url: "https://github.com/example/app/pull/1", messageId: "done", chatId: "chat1", verdict: "changes_requested", options: { spice: 4, comment: true, fun: false, agent: "codex", model: "test-model" }, at } },
		issues: { issue: { status: "fixing", firstSeen: at, at } },
		sinks: { sink: { cursor: "sink-cursor", lastPollAt: at, lastError: "retry", counts: { polled: 3 } } },
		fixStarts: [at], deps: { lastRun: { repo: { windowStart: at, at, result: "running" } } },
		prWatch: { pr: { repo: "repo", kind: "fix", startedAt: at }, deps: { repo: "repo", kind: "deps", startedAt: at } },
	};
}

describe("channel-review database import", () => {
	test("preserves every field across import and restart, retaining the original source", () => {
		const legacy = legacyState();
		seed(legacy);
		const source = readFileSync(paths.statePath);
		open().close();
		expect(open().get()).toEqual(legacy);
		expect(readFileSync(paths.statePath)).toEqual(source);
		const db = rawDb();
		expect(db.query("SELECT env, legacy_source, imported_at FROM channel_review_state").get()).toMatchObject({ env: "dev", legacy_source: paths.statePath, imported_at: expect.any(String) });
		expect(db.query("SELECT status FROM channel_review_requests WHERE env = 'dev' ORDER BY status").all()).toEqual([{ status: "done" }, { status: "failed" }, { status: "pending" }, { status: "running" }]);
		expect(db.query("SELECT message_id, pid, pid_start FROM channel_review_current WHERE env = 'dev'").get()).toEqual({ message_id: "running", pid: 1234, pid_start: "process-start" });
		db.close(true);
	});

	test("never reimports a retained or malformed source over newer database state", () => {
		seed(legacyState());
		const store = open();
		store.markHandled("pending", "done", "chat2");
		store.setLastEventId("chat1", "new-cursor");
		store.close();
		writeFileSync(paths.statePath, "{malformed after import");
		const restarted = open();
		expect(restarted.get().handled.pending?.status).toBe("done");
		expect(restarted.get().lastEventIds.chat1).toBe("new-cursor");
	});

	test.each(["{bad json", JSON.stringify({ lastEventIds: { chat1: 42 } })])("refuses malformed JSON/fields without consuming the source, and retries after repair: %s", content => {
		writeFileSync(paths.statePath, content);
		expect(() => open()).toThrow();
		expect(readFileSync(paths.statePath, "utf8")).toBe(content);
		const db = rawDb();
		expect(db.query("SELECT count(*) AS n FROM channel_review_state").get()).toEqual({ n: 0 });
		db.close(true);
		seed(legacyState());
		expect(open().get()).toEqual(legacyState());
	});

	test("rolls back an import write failure and retries after the failure is removed", () => {
		const db = openDaemonDatabase({ dbPath: paths.dbPath, daemonDir: dirname(paths.dbPath) });
		db.run("CREATE TRIGGER fail_import AFTER INSERT ON channel_review_state BEGIN SELECT RAISE(ABORT, 'injected import failure'); END");
		seed(legacyState());
		const source = readFileSync(paths.statePath);
		expect(() => open()).toThrow("injected import failure");
		expect(db.query("SELECT count(*) AS n FROM channel_review_state").get()).toEqual({ n: 0 });
		expect(readFileSync(paths.statePath)).toEqual(source);
		db.run("DROP TRIGGER fail_import");
		db.close(true);
		expect(open().get()).toEqual(legacyState());
	});

	test("imports dev and prod independently into the same database", () => {
		const prod = channelReviewPaths("prod", { env: home.env });
		seed({ lastEventIds: { chat1: "dev" } });
		seed({ lastEventIds: { chat1: "prod" } }, prod);
		const devStore = open();
		const prodStore = open(prod);
		devStore.markHandled("shared-id", "failed");
		prodStore.markHandled("shared-id", "done");
		expect(paths.dbPath).toBe(prod.dbPath);
		expect(readStateSnapshot(paths).lastEventIds).toEqual({ chat1: "dev" });
		expect(readStateSnapshot(prod).lastEventIds).toEqual({ chat1: "prod" });
		expect(readStateSnapshot(paths).handled["shared-id"]?.status).toBe("failed");
		expect(readStateSnapshot(prod).handled["shared-id"]?.status).toBe("done");
	});

	test("imports a legacy checkpoint once when separate processes initialize together", async () => {
		seed(legacyState());
		const module = new URL("../src/state.ts", import.meta.url).pathname;
		const script = `import { createStateStore } from ${JSON.stringify(module)};
			createStateStore(JSON.parse(process.argv[1])).close();`;
		const children = Array.from({ length: 2 }, () => Bun.spawn(
			[process.execPath, "-e", script, JSON.stringify(paths)], { stdout: "pipe", stderr: "pipe" }));
		const results = await Promise.all(children.map(async child => ({
			code: await child.exited, stderr: await new Response(child.stderr).text(),
		})));
		expect(results).toEqual(children.map(() => ({ code: 0, stderr: "" })));
		const db = rawDb();
		expect(db.query("SELECT env, revision FROM channel_review_state").all()).toEqual([{ env: "dev", revision: 0 }]);
		db.close(true);
		expect(readStateSnapshot(paths)).toEqual(legacyState());
	});

	test("refuses a stale writer instead of overwriting another connection's changes", () => {
		const first = open();
		const second = open();
		first.markHandled("first", "done");
		expect(() => second.markHandled("second", "pending")).toThrow("another connection");
		expect(readStateSnapshot(paths).handled).toMatchObject({ first: { status: "done" } });
		expect(readStateSnapshot(paths).handled).not.toHaveProperty("second");
	});
});
