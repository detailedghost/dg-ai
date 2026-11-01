import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { MESSAGE_TTL_SECONDS, PhoneDb } from "../../src/phone/db";
import { pendingIdsToDrop } from "../../src/phone/thread";
import { migrateThreadSchema } from "../../src/phone/thread-schema";

const homes: string[] = [];

afterEach(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
	homes.length = 0;
});

/** A phone.db in the shape 1.26.0 wrote: schema version 2, no thread tables, no messages.thread_id. */
function writeV126(paths: DgPaths): void {
	mkdirSync(paths.phoneRoot, { recursive: true });
	const db = new Database(PhoneDb.path(paths), { create: true, strict: true });
	db.run(`CREATE TABLE keys (
		id TEXT PRIMARY KEY,
		nsec TEXT,
		in_store INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	) STRICT`);
	db.run(`CREATE TABLE contacts (
		npub TEXT PRIMARY KEY,
		handle TEXT NOT NULL UNIQUE,
		relays TEXT NOT NULL,
		key_id TEXT NOT NULL REFERENCES keys(id),
		added_at INTEGER NOT NULL,
		via TEXT NOT NULL
	) STRICT`);
	db.run(`CREATE TABLE invites (
		secret TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL,
		as_name TEXT NOT NULL,
		name TEXT,
		key_id TEXT NOT NULL REFERENCES keys(id)
	) STRICT`);
	db.run(`CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
		ts INTEGER NOT NULL,
		sender TEXT NOT NULL,
		contact TEXT NOT NULL,
		text TEXT NOT NULL,
		call INTEGER NOT NULL DEFAULT 0,
		read_at INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0
	) STRICT`);
	db.run("CREATE INDEX idx_messages_ts ON messages(ts)");
	db.run("CREATE INDEX idx_messages_unread ON messages(ts) WHERE direction = 'in' AND read_at IS NULL");
	db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
	db.run("ALTER TABLE invites ADD COLUMN relays TEXT NOT NULL DEFAULT '[]'");
	db.run("PRAGMA user_version = 2");
	db.run(
		"INSERT INTO keys (id, nsec, in_store, created_at) VALUES ('default', NULL, 1, 10)",
	);
	db.run(
		"INSERT INTO contacts (npub, handle, relays, key_id, added_at, via) VALUES ('npub1peer', 'peer', '[]', 'default', 10, 'accept')",
	);
	db.run(
		"INSERT INTO messages (id, direction, ts, sender, contact, text, call, read_at, attempts) VALUES ('m1', 'in', 20, 'npub1peer', 'npub1peer', 'hello-one', 0, NULL, 0)",
	);
	db.run(
		"INSERT INTO invites (secret, expires_at, as_name, name, key_id, relays) VALUES ('abc', 99, 'dg', NULL, 'default', '[]')",
	);
	db.close();
}

function freshPaths(): DgPaths {
	const home = mkdtempSync(join(tmpdir(), "dg-phone-thread-migrate-"));
	homes.push(home);
	return resolveDgPaths({ env: { DG_HOME: home } });
}

describe("thread schema migration", () => {
	it("upgrades a v1.26.0 database, keeps the one-to-one row, and can run twice", () => {
		const paths = freshPaths();
		writeV126(paths);
		const raw = new Database(PhoneDb.path(paths), { strict: true });
		migrateThreadSchema(raw);
		migrateThreadSchema(raw);
		const versionBeforeOpen = (raw.query("PRAGMA user_version").get() as { user_version: number }).user_version;
		raw.close();
		expect(versionBeforeOpen).toBe(2);

		const db = PhoneDb.open(paths, () => 30);
		const opened = new Database(PhoneDb.path(paths), { readonly: true });
		const version = (opened.query("PRAGMA user_version").get() as { user_version: number }).user_version;
		const tables = (opened.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
			(row) => row.name,
		);
		const index = opened.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_thread'").get();
		opened.close();

		expect(version).toBe(4);
		expect(tables).toContain("threads");
		expect(tables).toContain("thread_members");
		expect(tables).toContain("pending_threads");
		expect(index).not.toBeNull();
		const row = db.recentMessages(10, "npub1peer");
		expect(row.map((message) => message.id)).toEqual(["m1"]);
		expect(row[0]?.thread_id).toBeNull();
		expect(row[0]?.text).toBe("hello-one");
		expect(db.recentMessages(10).map((message) => message.id)).toEqual(["m1"]);
		db.close();
	});

	it("leaves a one-to-one contact query unchanged once a thread row exists", () => {
		const paths = freshPaths();
		const db = PhoneDb.open(paths, () => 100);
		db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
		db.insertThread({ id: "room", handle: "#ops", subject: "ops", key_id: "default", created_at: 100, via: "local" });
		db.addMessage({ id: "direct", direction: "in", ts: 10, sender: "npub1peer", contact: "npub1peer", text: "direct", call: 0 });
		db.addMessage({
			id: "group",
			direction: "in",
			ts: 11,
			sender: "npub1peer",
			contact: "npub1peer",
			text: "group",
			call: 0,
			thread_id: "room",
		});

		expect(db.recentMessages(10, "npub1peer").map((message) => message.id)).toEqual(["direct"]);
		expect(db.recentMessages(10, undefined, "room").map((message) => message.id)).toEqual(["group"]);
		expect(db.recentMessages(10).map((message) => message.id)).toEqual(["direct", "group"]);
		db.close();
	});

	it("expires a future-dated held row by the local receive time", () => {
		const paths = freshPaths();
		let now = 2_000_000;
		const db = PhoneDb.open(paths, () => now);
		expect(
			db.insertPending({
				rumor_id: "future",
				room_id: "future",
				sender: "npub1peer",
				members: "[]",
				subject: null,
				text: "held-body",
				ts: now + 10 * 365 * 24 * 60 * 60,
			}),
		).toBe(true);
		expect(db.pendingByRumor("future")?.received_at).toBe(now);
		db.upsertHeldNotice("1 held thread");
		now += MESSAGE_TTL_SECONDS + 1;
		db.pruneMessages();
		expect(db.listPending()).toEqual([]);
		expect(db.heldNotice()).toBeUndefined();
		db.close();
	});

	it("drops the oldest held rows past the per-sender and total caps", () => {
		const paths = freshPaths();
		let now = 100;
		const db = PhoneDb.open(paths, () => now);
		for (let index = 0; index < 6; index += 1) {
			now = 100 + index;
			db.insertPending({
				rumor_id: `s${index}`,
				room_id: `room-${index}`,
				sender: "npub1s",
				members: "[]",
				subject: null,
				text: `body-${index}`,
				ts: now + 10 * 365 * 24 * 60 * 60,
			});
		}
		db.deletePending(
			pendingIdsToDrop(
				db.listPending().map((row) => ({ rumorId: row.rumor_id, sender: row.sender, ts: row.received_at })),
				5,
				50,
			),
		);
		db.syncHeldNotice();
		expect(db.listPending().map((row) => row.rumor_id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
		expect(db.pendingByRumor("s0")).toBeUndefined();
		expect(db.heldNotice()?.text).toBe("5 held threads");
		db.close();
	});
});
