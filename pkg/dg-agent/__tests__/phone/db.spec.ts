import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { PhoneDb } from "../../src/phone/db";

const NOW = 1_800_000_000;
let home: string;
let paths: DgPaths;
let now: number;
let db: PhoneDb;

function message(id: string, ts: number, text = id) {
	return { id, ts, sender: "npub1them", contact: "npub1them", text, direction: "in" as const, call: 0 };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-db-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	now = NOW;
	db = PhoneDb.open(paths, () => now);
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("PhoneDb", () => {
	it("keeps the database private in a private dir", () => {
		expect(statSync(PhoneDb.path(paths)).mode & 0o777).toBe(0o600);
		expect(statSync(paths.phoneRoot).mode & 0o777).toBe(0o700);
	});

	it("makes an existing database private again when it opens", () => {
		db.close();
		chmodSync(PhoneDb.path(paths), 0o644);
		db = PhoneDb.open(paths, () => now);
		expect(statSync(PhoneDb.path(paths)).mode & 0o777).toBe(0o600);
	});

	it("zeroes deleted settings, so a moved key leaves no bytes behind", () => {
		db.set("nsec", "nsec1secretsecretsecret");
		db.unset("nsec");
		db.close();
		expect(readFileSync(PhoneDb.path(paths)).includes("nsec1secretsecretsecret")).toBe(false);
		expect(existsSync(`${PhoneDb.path(paths)}-wal`)).toBe(false);
		db = PhoneDb.open(paths, () => now);
	});

	it("reports the schema version it created", () => {
		const raw = new Database(PhoneDb.path(paths), { readonly: true });
		const { user_version } = raw.query("PRAGMA user_version").get() as { user_version: number };
		raw.close();

		expect(user_version).toBe(1);
	});

	describe("messages", () => {
		it("returns each unread incoming message once, oldest first, and marks it read", () => {
			db.addMessage(message("b", NOW - 10));
			db.addMessage(message("a", NOW - 20));

			expect(db.takeUnread().map((m) => m.id)).toEqual(["a", "b"]);
			expect(db.takeUnread()).toEqual([]);
		});

		it("keeps the call flag on the message that paired the contact", () => {
			db.addMessage({ ...message("c", NOW), call: 1 });
			db.addMessage(message("d", NOW + 1));

			const rows = db.takeUnread();
			expect(rows.map((r) => [r.id, r.call])).toEqual([
				["c", 1],
				["d", 0],
			]);
		});

		it("stores sent messages marked read right away, never as unread", () => {
			db.addMessage({ ...message("out1", NOW), direction: "out" });

			expect(db.takeUnread()).toEqual([]);
			expect(db.recentMessages(10).map((m) => [m.id, m.direction, m.read_at !== null])).toEqual([["out1", "out", true]]);
		});

		it("ignores a second copy of the same id", () => {
			expect(db.addMessage(message("x", NOW))).toBe(true);
			expect(db.addMessage(message("x", NOW))).toBe(false);

			expect(db.takeUnread()).toHaveLength(1);
		});

		it("returns the most recent N messages, oldest first", () => {
			db.addMessage(message("m1", NOW));
			db.addMessage(message("m2", NOW + 1));
			db.addMessage(message("m3", NOW + 2));

			expect(db.recentMessages(2).map((m) => m.id)).toEqual(["m2", "m3"]);
		});

		it("filters recent messages to one contact without touching read_at", () => {
			db.addMessage({ ...message("a1", NOW), contact: "npub1a" });
			db.addMessage({ ...message("b1", NOW + 1), contact: "npub1b" });

			const rows = db.recentMessages(10, "npub1a");

			expect(rows.map((m) => m.id)).toEqual(["a1"]);
			expect(rows[0]?.read_at).toBeNull();
		});

		it("deletes messages older than seven days when it opens", () => {
			db.addMessage(message("old", NOW - 7 * 24 * 60 * 60 - 1));
			db.addMessage(message("fresh", NOW - 7 * 24 * 60 * 60 + 60));
			db.close();

			db = PhoneDb.open(paths, () => now);

			expect(db.recentMessages(10).map((m) => m.id)).toEqual(["fresh"]);
		});

		it("never stores a message that is already past the ttl", () => {
			expect(db.addMessage(message("stale", NOW - 7 * 24 * 60 * 60 - 1))).toBe(false);
			expect(db.recentMessages(10)).toEqual([]);
		});
	});

	describe("hook delivery queue", () => {
		it("hands back the oldest unread message under the attempt cap, skipping those at or over it", () => {
			db.addMessage(message("a", NOW));
			db.addMessage(message("b", NOW + 1));
			db.bumpAttempts("a");
			db.bumpAttempts("a");

			expect(db.nextDeliverable(2)?.id).toBe("b");
			expect(db.nextDeliverable(3)?.id).toBe("a");
		});

		it("returns undefined once every unread row is at or over the cap", () => {
			db.addMessage(message("a", NOW));
			db.bumpAttempts("a");

			expect(db.nextDeliverable(1)).toBeUndefined();
		});

		it("lists stuck messages oldest first and leaves rows under the cap out", () => {
			db.addMessage(message("a", NOW));
			db.addMessage(message("b", NOW + 1));
			db.bumpAttempts("a");
			db.bumpAttempts("a");

			expect(db.stuckMessages(2).map((m) => m.id)).toEqual(["a"]);
		});

		it("bumps attempts by one and returns the new count", () => {
			db.addMessage(message("a", NOW));

			expect(db.bumpAttempts("a")).toBe(1);
			expect(db.bumpAttempts("a")).toBe(2);
		});
	});

	describe("keys", () => {
		it("inserts a key row only once, and a later makeDefault call is discarded", () => {
			const first = db.ensureKeyRow("default", () => ({ nsec: "nsec1first", in_store: 0 }));
			const second = db.ensureKeyRow("default", () => ({ nsec: "nsec1second", in_store: 0 }));

			expect(first.nsec).toBe("nsec1first");
			expect(second.nsec).toBe("nsec1first");
			expect(db.getKey("default")?.nsec).toBe("nsec1first");
		});

		it("updates an existing row in place through putKey", () => {
			db.ensureKeyRow("default", () => ({ nsec: "nsec1first", in_store: 0 }));

			db.putKey({ id: "default", nsec: null, in_store: 1 });

			expect(db.getKey("default")).toMatchObject({ nsec: null, in_store: 1 });
		});

		it("lists every key id in order", () => {
			db.ensureKeyRow("work", () => ({ nsec: null, in_store: 1 }));
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));

			expect(db.listKeyIds()).toEqual(["default", "work"]);
		});
	});

	describe("contacts", () => {
		it("round-trips a contact and finds it by npub or handle", () => {
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.putContact({ npub: "npub1x", handle: "velora", relays: "[]", key_id: "default", added_at: NOW, via: "accept" });

			expect(db.getContactByHandle("velora")?.npub).toBe("npub1x");
			expect(db.getContactByNpub("npub1x")?.handle).toBe("velora");
			expect(db.listContacts().map((c) => c.handle)).toEqual(["velora"]);
		});

		it("moves a contact's key_id on a re-accept", () => {
			db.ensureKeyRow("work", () => ({ nsec: null, in_store: 1 }));
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.putContact({ npub: "npub1x", handle: "velora", relays: "[]", key_id: "work", added_at: NOW, via: "migrated" });

			db.setContactKeyId("npub1x", "default");

			expect(db.getContactByNpub("npub1x")?.key_id).toBe("default");
		});

		it("removes a contact by npub", () => {
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.putContact({ npub: "npub1x", handle: "velora", relays: "[]", key_id: "default", added_at: NOW, via: "accept" });

			db.removeContact("npub1x");

			expect(db.getContactByNpub("npub1x")).toBeUndefined();
		});
	});

	describe("invites", () => {
		it("lists only unexpired invites and consumes one by secret", () => {
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.putInvite({ secret: "live", expires_at: NOW + 100, as_name: "dg", name: null, key_id: "default" });
			db.putInvite({ secret: "dead", expires_at: NOW - 100, as_name: "dg", name: null, key_id: "default" });

			expect(db.listLiveInvites().map((i) => i.secret)).toEqual(["live"]);

			db.consumeInvite("live");

			expect(db.listLiveInvites()).toEqual([]);
		});
	});

	describe("settings", () => {
		it("keeps settings as JSON, and setOnce keeps the first value", () => {
			db.set("config", { relays: ["wss://x"] });

			expect(db.get("config")).toEqual({ relays: ["wss://x"] });
			expect(db.setOnce("nsec", "first")).toBe("first");
			expect(db.setOnce("nsec", "second")).toBe("first");
			db.unset("nsec");
			expect(db.get("nsec")).toBeUndefined();
		});
	});
});
