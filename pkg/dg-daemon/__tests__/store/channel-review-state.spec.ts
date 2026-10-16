import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "@dg/common/daemon-db";
import { readSchemaVersion, resolveDgPaths } from "@dg/common/node";
import { createStateStore, readStateSnapshot } from "../../../channel-review/src/state";
import { channelReviewPaths } from "../../../channel-review/src/paths";
import { ChatStore } from "../../src/store";
import { cleanupDgHome, FILE_ONLY_SEAMS, freshDgHome } from "../utils/daemon-harness";

const homes: string[] = [];
function setup() {
	const home = freshDgHome(); homes.push(home);
	const system = { env: { DG_HOME: home } };
	return { home, paths: resolveDgPaths(system), reviewPaths: channelReviewPaths("dev", system) };
}
afterEach(() => { for (const home of homes.splice(0)) cleanupDgHome(home); });

function addMessage(store: ChatStore, id: string) {
	store.insertMessage({ sessionId: "compat-session", id, role: "user", body: `encrypted body ${id}` });
}

describe("channel-review sharing daemon.db", () => {
	test("opens an existing v10 daemon.db with encrypted rows and preserves its crypto metadata and key", async () => {
		const { paths, reviewPaths } = setup();
		const original = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		addMessage(original, "before-import");
		const meta = original.cryptoMeta();
		original.close();
		// Restore the exact pre-review schema; migrations 1-10 are unchanged.
		const legacy = new Database(paths.dbPath, { strict: true });
		legacy.run("DROP VIEW channel_review_current");
		legacy.run("DROP VIEW channel_review_requests");
		legacy.run("DROP TABLE channel_review_state");
		legacy.run("PRAGMA user_version = 10");
		const ciphertext = legacy.query("SELECT body_ciphertext FROM messages").get();
		expect(readSchemaVersion(legacy)).toBe(10);
		legacy.close(true);
		const key = readFileSync(paths.keyPath);
		mkdirSync(dirname(reviewPaths.statePath), { recursive: true });
		writeFileSync(reviewPaths.statePath, JSON.stringify({ lastEventIds: { chat: "saved-cursor" } }));
		const review = createStateStore(reviewPaths);
		review.markHandled("request", "running", "chat");
		review.close();
		const main = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		expect(main.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
		expect(main.cryptoMeta()).toEqual(meta);
		expect(readFileSync(paths.keyPath)).toEqual(key);
		expect(main.peekAll("compat-session")[0]?.body).toBe("encrypted body before-import");
		main.close();
		const raw = new Database(paths.dbPath, { readonly: true });
		expect(raw.query("SELECT body_ciphertext FROM messages").get()).toEqual(ciphertext);
		raw.close(true);
		const snapshots = readdirSync(paths.daemonDir).filter(name => name.startsWith("pre-migration-v12-"));
		expect(snapshots).toHaveLength(1);
		expect(readStateSnapshot(reviewPaths).lastEventIds).toEqual({ chat: "saved-cursor" });
	});

	test.each(["main-first", "review-first"])("supports %s with both connections open and independent writes", async order => {
		const { paths, reviewPaths } = setup();
		let main: ChatStore;
		let review: ReturnType<typeof createStateStore>;
		if (order === "main-first") {
			main = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			review = createStateStore(reviewPaths);
		} else {
			review = createStateStore(reviewPaths);
			main = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		}
		try {
			addMessage(main, "during-review");
			review.setLastEventId("chat", "event");
			review.markHandled("request", "done", "chat");
			expect(main.peekAll("compat-session")[0]?.body).toBe("encrypted body during-review");
			expect(readStateSnapshot(reviewPaths).handled.request?.status).toBe("done");
		} finally { review.close(); main.close(); }
		const restarted = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		expect(restarted.peekAll("compat-session")).toHaveLength(1);
		restarted.close();
		expect(readStateSnapshot(reviewPaths).lastEventIds).toEqual({ chat: "event" });
	});

	test("handles concurrent main-daemon crypto startup and first review import without sharing key ownership", async () => {
		const { paths, reviewPaths } = setup();
		const opening = ChatStore.open(paths, FILE_ONLY_SEAMS);
		const review = createStateStore(reviewPaths);
		review.markHandled("request", "pending");
		const main = await opening;
		try {
			addMessage(main, "simultaneous");
			expect(main.peekAll("compat-session")[0]?.body).toBe("encrypted body simultaneous");
			expect(readStateSnapshot(reviewPaths).handled.request?.status).toBe("pending");
		} finally { review.close(); main.close(); }
	});
});
