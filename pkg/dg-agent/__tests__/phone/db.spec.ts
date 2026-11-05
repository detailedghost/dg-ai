import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { type ImageFetchRow, LOOKBACK_SECONDS, MESSAGE_TTL_SECONDS, OUTBOX_DIR, PHI_TTL_SECONDS, PhoneDb } from "../../src/phone/db";
import { FILES_DIR } from "../../src/phone/image";

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

		expect(user_version).toBe(8);
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
			db.addMessage(message("old", NOW - MESSAGE_TTL_SECONDS - 1));
			db.addMessage(message("fresh", NOW - MESSAGE_TTL_SECONDS + 60));
			db.close();

			db = PhoneDb.open(paths, () => now);

			expect(db.recentMessages(10).map((m) => m.id)).toEqual(["fresh"]);
		});

		it("stores the file JSON on a row and null when there is none", () => {
			db.addMessage({ ...message("img", NOW), file: '{"sha256":"ab","type":"image/png","size":3}' });
			db.addMessage(message("txt", NOW + 1));

			expect(db.recentMessages(10).map((m) => [m.id, m.file])).toEqual([
				["img", '{"sha256":"ab","type":"image/png","size":3}'],
				["txt", null],
			]);
		});

		it("stores phi as 1 or 0 and prunes PHI rows 24 hours after they arrive while plain rows stay", () => {
			db.addMessage({ ...message("phi-old", NOW - 60), direction: "out", phi: true });
			db.addMessage({ ...message("plain-old", NOW - 60), direction: "out" });
			now = NOW + PHI_TTL_SECONDS - 30;
			db.addMessage({ ...message("phi-fresh", NOW), direction: "out", phi: true });
			now = NOW + PHI_TTL_SECONDS + 1;

			db.pruneMessages();

			expect(db.recentMessages(10).map((m) => [m.id, m.phi])).toEqual([
				["plain-old", 0],
				["phi-fresh", 1],
			]);
		});

		it("expires a PHI row by its local arrival, not the sender clock", () => {
			db.addMessage({ ...message("backdated", NOW - PHI_TTL_SECONDS - 60), phi: true });

			db.pruneMessages();

			expect(db.recentMessages(10).map((m) => m.id)).toEqual(["backdated"]);
		});

		it("refuses an expired PHI id until the replay window ends", () => {
			db.addMessage({ ...message("phi", NOW), phi: true });
			now = NOW + PHI_TTL_SECONDS + 1;
			db.pruneMessages();

			expect(db.addMessage({ ...message("phi", NOW), phi: true })).toBe(false);
			now += MESSAGE_TTL_SECONDS + LOOKBACK_SECONDS - 1;
			expect(db.addMessage({ ...message("phi", now), phi: true })).toBe(false);
			expect(db.recentMessages(10)).toEqual([]);

			now += 2;
			expect(db.addMessage({ ...message("phi", now), phi: true })).toBe(true);
		});

		it("never stores a message that is already past the ttl", () => {
			expect(db.addMessage(message("stale", NOW - MESSAGE_TTL_SECONDS - 1))).toBe(false);
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
		it("inserts a key row only once, and skips makeDefault once the row already exists", () => {
			let calls = 0;
			const makeDefault = () => {
				calls += 1;
				return { nsec: "nsec1first", in_store: 0 };
			};

			const first = db.ensureKeyRow("default", makeDefault);
			const second = db.ensureKeyRow("default", makeDefault);

			expect(first.nsec).toBe("nsec1first");
			expect(second.nsec).toBe("nsec1first");
			expect(db.getKey("default")?.nsec).toBe("nsec1first");
			expect(calls).toBe(1);
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

		it("consumes an invite once and reports whether this call won it", () => {
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.putInvite({ secret: "live", expires_at: NOW + 100, as_name: "dg", name: null, key_id: "default" });
			db.putInvite({ secret: "dead", expires_at: NOW - 100, as_name: "dg", name: null, key_id: "default" });

			expect(db.consumeInvite("live")).toBe(true);
			expect(db.consumeInvite("live")).toBe(false);
			expect(db.consumeInvite("dead")).toBe(false);
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

	describe("outbox", () => {
		const X = "a".repeat(64);
		const Y = "b".repeat(64);
		const outbox = () => join(paths.phoneRoot, OUTBOX_DIR);
		const stage = (name: string, ageSeconds: number) => {
			mkdirSync(outbox(), { recursive: true });
			const file = join(outbox(), name);
			writeFileSync(file, "cipher");
			const at = NOW - ageSeconds;
			utimesSync(file, at, at);
			return file;
		};

		it("records a staged blob with the key that sent it and the recipients allowed to fetch it", () => {
			db.addOutbox(X, "k1", ["pub1", "pub2"]);

			expect(db.outboxRecipients(X)).toEqual(["pub1", "pub2"]);
			expect(db.outboxKeyId(X)).toBe("k1");
			expect(db.outboxRecipients(Y)).toEqual([]);
			expect(db.outboxKeyId(Y)).toBeUndefined();
		});

		it("prunes rows and files older than seven days and keeps fresh ones", () => {
			now = NOW - MESSAGE_TTL_SECONDS - 1;
			db.addOutbox(X, "k1", ["pub1"]);
			now = NOW;
			db.addOutbox(Y, "k1", ["pub2"]);
			const old = stage(X, MESSAGE_TTL_SECONDS + 1);
			const fresh = stage(Y, 60);

			db.pruneMessages();

			expect(existsSync(old)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			expect(db.outboxRecipients(X)).toEqual([]);
			expect(db.outboxRecipients(Y)).toEqual(["pub2"]);
		});

		it("prunes a PHI blob after 24 hours while a plain blob of the same age stays", () => {
			now = NOW - PHI_TTL_SECONDS - 1;
			db.addOutbox(X, "k1", ["pub1"], { phi: true });
			db.addOutbox(Y, "k1", ["pub2"]);
			now = NOW;
			const phi = stage(X, PHI_TTL_SECONDS + 1);
			const plain = stage(Y, PHI_TTL_SECONDS + 1);

			db.pruneMessages();

			expect(PHI_TTL_SECONDS).toBe(24 * 60 * 60);
			expect(existsSync(phi)).toBe(false);
			expect(db.outboxRecipients(X)).toEqual([]);
			expect(existsSync(plain)).toBe(true);
			expect(db.outboxRecipients(Y)).toEqual(["pub2"]);
		});

		it("removes an old leftover file that has no row, such as a crashed temp write", () => {
			const leftover = stage(`${X}.123.tmp`, MESSAGE_TTL_SECONDS + 1);

			db.pruneMessages();

			expect(existsSync(leftover)).toBe(false);
		});

		it("never follows or removes a symlink in the outbox", () => {
			const target = join(home, "keep.txt");
			writeFileSync(target, "keep");
			mkdirSync(outbox(), { recursive: true });
			const link = join(outbox(), X);
			symlinkSync(target, link);
			now = NOW - MESSAGE_TTL_SECONDS - 1;
			db.addOutbox(X, "k1", ["pub1"]);
			now = NOW;

			db.pruneMessages();

			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("keep");
			expect(db.outboxRecipients(X)).toEqual([]);
		});
	});

	describe("held groups", () => {
		function held(rumorId: string, phi?: boolean) {
			return { rumor_id: rumorId, room_id: "room", sender: "npub1them", members: "[]", subject: null, text: "body", ts: NOW - 3 * 24 * 60 * 60, ...(phi ? { phi } : {}) };
		}

		it("expires a held PHI row 24 hours after it arrives while a plain held row stays", () => {
			db.insertPending(held("phi", true));
			db.insertPending(held("plain"));
			now = NOW + PHI_TTL_SECONDS - 1;
			db.pruneMessages();
			expect(db.listPending().map((row) => [row.rumor_id, row.phi])).toEqual([
				["phi", 1],
				["plain", 0],
			]);

			now = NOW + PHI_TTL_SECONDS + 1;
			db.pruneMessages();

			expect(db.listPending().map((row) => row.rumor_id)).toEqual(["plain"]);
		});

		it("refuses to hold an expired PHI rumor again", () => {
			db.insertPending(held("phi", true));
			now = NOW + PHI_TTL_SECONDS + 1;
			db.pruneMessages();

			expect(db.insertPending(held("phi", true))).toBe(false);
			expect(db.listPending()).toEqual([]);
		});
	});

	describe("delivery receipts", () => {
		const ME = "npub1me";
		const BOB = "npub1bob";
		const CAROL = "npub1carol";
		const sent = (id: string, extra: { contact?: string; thread_id?: string } = {}) =>
			db.addMessage({ id, ts: NOW, sender: ME, contact: extra.contact ?? BOB, text: id, direction: "out", call: 0, thread_id: extra.thread_id });
		const deliveredAt = (id: string) => db.recentMessages(50).find((row) => row.id === id)?.delivered_at;

		it("marks a direct outgoing row delivered only for its recipient and the key that sent it", () => {
			sent("m1");

			expect(db.markDelivered("m1", CAROL, ME, NOW + 1)).toBe(false);
			expect(db.markDelivered("m1", BOB, "npub1other", NOW + 1)).toBe(false);
			expect(deliveredAt("m1")).toBeNull();
			expect(db.markDelivered("m1", BOB, ME, NOW + 2)).toBe(true);
			expect(db.markDelivered("m1", BOB, ME, NOW + 9)).toBe(false);
			expect(deliveredAt("m1")).toBe(NOW + 2);
		});

		it("holds a receipt that arrives before its row is saved and applies it when the row lands", () => {
			expect(db.markDelivered("early", CAROL, ME, NOW + 1)).toBe(false);
			expect(db.markDelivered("early", BOB, ME, NOW + 2)).toBe(false);

			sent("early");

			expect(deliveredAt("early")).toBe(NOW + 2);
		});

		it("forgets a held receipt after ten minutes", () => {
			db.markDelivered("late", BOB, ME, NOW);
			now = NOW + 601;
			db.pruneMessages();

			sent("late");

			expect(deliveredAt("late")).toBeNull();
		});

		it("never marks an incoming row", () => {
			db.addMessage(message("in1", NOW));

			expect(db.markDelivered("in1", "npub1them", "npub1them", NOW)).toBe(false);
		});

		it("marks a thread row for any member and ignores a non-member", () => {
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.insertThread({ id: "room", handle: "#ops", subject: "", key_id: "default", created_at: NOW, via: "local" });
			for (const npub of [ME, BOB]) db.insertThreadMember("room", npub);
			sent("t1", { contact: ME, thread_id: "room" });

			expect(db.markDelivered("t1", CAROL, ME, NOW + 1)).toBe(false);
			expect(db.markDelivered("t1", BOB, ME, NOW + 1)).toBe(true);
		});

		it("marks a ping for its recipient and prunes it after the message window", () => {
			db.addPing({ id: "p1", contact: BOB, sender: ME, sent_at: NOW });

			expect(db.markDelivered("p1", CAROL, ME, NOW + 1)).toBe(false);
			expect(db.pingRow("p1")).toMatchObject({ delivered_at: null, busy_at: null });
			expect(db.markDelivered("p1", BOB, ME, NOW + 3)).toBe(true);
			expect(db.pingRow("p1")).toMatchObject({ delivered_at: NOW + 3 });

			now = NOW + MESSAGE_TTL_SECONDS + 1;
			db.pruneMessages();
			expect(db.pingRow("p1")).toBeUndefined();
		});

		it("marks a ping busy only for its recipient, and never a message row", () => {
			db.addPing({ id: "p2", contact: BOB, sender: ME, sent_at: NOW });
			sent("m2");

			expect(db.markBusy("p2", CAROL, ME, NOW + 1)).toBe(false);
			expect(db.markBusy("m2", BOB, ME, NOW + 1)).toBe(false);
			expect(db.markBusy("p2", BOB, ME, NOW + 2)).toBe(true);
			expect(db.pingRow("p2")).toMatchObject({ delivered_at: null, busy_at: NOW + 2 });
			expect(deliveredAt("m2")).toBeNull();
		});
	});

	describe("last seen", () => {
		it("keeps the latest time and returns the one before it", () => {
			db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
			db.putContact({ npub: "npub1x", handle: "velora", relays: "[]", key_id: "default", added_at: NOW, via: "accept" });

			expect(db.touchLastSeen("npub1x", NOW)).toBeNull();
			expect(db.touchLastSeen("npub1x", NOW - 50)).toBe(NOW);
			expect(db.getContactByNpub("npub1x")?.last_seen).toBe(NOW);
			expect(db.touchLastSeen("npub1x", NOW + 10)).toBe(NOW);
			expect(db.getContactByNpub("npub1x")?.last_seen).toBe(NOW + 10);
		});
	});

	describe("image fetches", () => {
		const SHA = "a".repeat(64);
		const OTHER = "b".repeat(64);
		const fetchRow = (id: string): Omit<ImageFetchRow, "attempts"> => ({
			message_id: id,
			sender: "c".repeat(64),
			key_id: "k1",
			x: "d".repeat(64),
			ox: SHA,
			size: 100,
			key: "e".repeat(64),
			nonce: "f".repeat(24),
			next_at: NOW,
			deadline: NOW + MESSAGE_TTL_SECONDS,
		});
		const files = () => join(paths.phoneRoot, FILES_DIR);
		const place = (name: string, ageSeconds = 0) => {
			mkdirSync(files(), { recursive: true });
			const file = join(files(), name);
			writeFileSync(file, "png");
			const at = now - ageSeconds;
			utimesSync(file, at, at);
			return file;
		};
		const storedJson = (sha: string) => JSON.stringify({ sha256: sha, type: "image/png", size: 3 });

		it("keeps a pending row away from the hook until the fetch ends, then shows it unread again", () => {
			db.addMessage(message("img", NOW, "[image pending]"));
			db.addImageFetch(fetchRow("img"));
			expect(db.nextDeliverable(5)).toBeUndefined();
			expect(db.pendingImageCount()).toBe(1);
			db.takeUnread();

			db.finishImage("img", "[image]", storedJson(SHA));

			expect(db.imageFetches()).toEqual([]);
			expect(db.nextDeliverable(5)).toMatchObject({ id: "img", text: "[image]", file: storedJson(SHA), read_at: null, attempts: 0 });
		});

		it("pulls a deferred fetch from one sender forward to now and leaves other senders alone", () => {
			db.addMessage(message("a", NOW, "[image pending]"));
			db.addMessage(message("b", NOW, "[image pending]"));
			db.addImageFetch({ ...fetchRow("a"), next_at: NOW + 600 });
			db.addImageFetch({ ...fetchRow("b"), sender: "9".repeat(64), next_at: NOW + 600 });

			db.retryImageFetchesFrom("c".repeat(64), NOW);

			expect(db.imageFetches().map((row) => [row.message_id, row.next_at])).toEqual([
				["a", NOW],
				["b", NOW + 600],
			]);
		});

		it("drops the key and nonce from the database once the fetch ends", () => {
			db.addMessage(message("img", NOW, "[image pending]"));
			db.addImageFetch(fetchRow("img"));

			db.finishImage("img", "[image unavailable: sender offline]", null);
			db.close();

			const raw = readFileSync(PhoneDb.path(paths));
			expect(raw.includes(Buffer.from("e".repeat(64)))).toBe(false);
			db = PhoneDb.open(paths, () => now);
		});

		it("records a retry with its attempt count and next time", () => {
			db.addMessage(message("img", NOW, "[image pending]"));
			db.addImageFetch(fetchRow("img"));

			db.deferImageFetch("img", 3, NOW + 240);

			expect(db.imageFetches()).toEqual([{ ...fetchRow("img"), attempts: 3, next_at: NOW + 240 }]);
		});

		it("drops a fetch row when its message is pruned", () => {
			db.addMessage({ ...message("img", NOW, "[image pending]"), phi: true });
			db.addImageFetch(fetchRow("img"));
			now = NOW + PHI_TTL_SECONDS + 1;

			db.pruneMessages();

			expect(db.imageFetches()).toEqual([]);
		});

		it("unlinks the file of a pruned row unless another row still uses it", () => {
			db.addMessage({ ...message("phi", NOW), phi: true, file: storedJson(SHA) });
			db.addMessage({ ...message("plain", NOW), file: storedJson(OTHER) });
			db.addMessage({ ...message("phi-twin", NOW), phi: true, file: storedJson(OTHER) });
			const gone = place(`${SHA}.png`);
			const kept = place(`${OTHER}.png`);
			now = NOW + PHI_TTL_SECONDS + 1;

			db.pruneMessages();

			expect(existsSync(gone)).toBe(false);
			expect(existsSync(kept)).toBe(true);
		});

		it("removes leftover temp writes and old files no row uses, and keeps a fresh unreferenced file", () => {
			const tmp = place(`${SHA}.png.1.abc.tmp`, 120);
			const orphan = place(`${OTHER}.png`, PHI_TTL_SECONDS + 1);
			const fresh = place(`${"9".repeat(64)}.png`, 5);

			db.pruneMessages();

			expect(existsSync(tmp)).toBe(false);
			expect(existsSync(orphan)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
		});

		it("never follows or removes a symlink in files", () => {
			const target = join(home, "keep.png");
			writeFileSync(target, "keep");
			mkdirSync(files(), { recursive: true });
			symlinkSync(target, join(files(), `${SHA}.png`));
			db.addMessage({ ...message("phi", NOW), phi: true, file: storedJson(SHA) });
			now = NOW + PHI_TTL_SECONDS + 1;

			db.pruneMessages();

			expect(readFileSync(target, "utf8")).toBe("keep");
		});
	});
});
