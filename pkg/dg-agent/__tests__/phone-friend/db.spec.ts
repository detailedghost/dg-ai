import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { MESSAGE_TTL_SECONDS, PhoneFriendDb } from "../../src/phone-friend/db";
import { type LinePaths, linePaths } from "../../src/phone-friend/line";

const NOW = 1_800_000_000;
let home: string;
let line: LinePaths;
let now: number;
let inbox: PhoneFriendDb;

function message(id: string, ts: number, text = id) {
	return { id, ts, from: "npub1them", text };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-inbox-"));
	line = linePaths(resolveDgPaths({ env: { DG_HOME: home } }));
	now = NOW;
	inbox = PhoneFriendDb.open(line, () => now);
});

afterEach(() => {
	inbox.close();
	rmSync(home, { recursive: true, force: true });
});

describe("PhoneFriendDb", () => {
	it("keeps the database private in a private dir", () => {
		expect(statSync(line.dbPath).mode & 0o777).toBe(0o600);
		expect(statSync(line.dir).mode & 0o777).toBe(0o700);
	});

	it("makes an existing database private again when it opens", () => {
		inbox.close();
		chmodSync(line.dbPath, 0o644);
		inbox = PhoneFriendDb.open(line, () => now);
		expect(statSync(line.dbPath).mode & 0o777).toBe(0o600);
	});

	it("zeroes deleted rows, so a moved key leaves no bytes behind", () => {
		inbox.set("nsec", "nsec1secretsecretsecret");
		inbox.unset("nsec");
		inbox.close();
		expect(readFileSync(line.dbPath).includes("nsec1secretsecretsecret")).toBe(false);
		inbox = PhoneFriendDb.open(line, () => now);
	});

	it("returns each unread incoming message once, oldest first, and marks it read", () => {
		inbox.add(message("b", NOW - 10), "in", "npub1them");
		inbox.add(message("a", NOW - 20), "in", "npub1them");

		expect(inbox.takeUnread().map((m) => m.id)).toEqual(["a", "b"]);
		expect(inbox.takeUnread()).toEqual([]);
	});

	it("keeps the call flag on the message that paired the contact", () => {
		inbox.add({ ...message("c", NOW), call: true }, "in", "npub1them");
		inbox.add(message("d", NOW + 1), "in", "npub1them");

		expect(inbox.takeUnread()).toEqual([
			{ id: "c", ts: NOW, from: "npub1them", text: "c", call: true },
			{ id: "d", ts: NOW + 1, from: "npub1them", text: "d" },
		]);
	});

	it("stores sent messages in the history but never as unread", () => {
		inbox.add(message("out1", NOW), "out", "npub1them");

		expect(inbox.takeUnread()).toEqual([]);
		expect(inbox.history().map((m) => [m.id, m.direction])).toEqual([["out1", "out"]]);
	});

	it("ignores a second copy of the same id", () => {
		expect(inbox.add(message("x", NOW), "in", "npub1them")).toBe(true);
		expect(inbox.add(message("x", NOW), "in", "npub1them")).toBe(false);

		expect(inbox.takeUnread()).toHaveLength(1);
	});

	it("knows every stored id and keeps the relay cursor", () => {
		inbox.add(message("k1", NOW), "in", "npub1them");
		inbox.add(message("k2", NOW), "out", "npub1them");
		inbox.setCursor(NOW - 5);

		expect(inbox.seen()).toEqual({ cursor: NOW - 5, ids: ["k1", "k2"] });
	});

	it("deletes messages older than seven days when it opens", () => {
		inbox.add(message("old", NOW - MESSAGE_TTL_SECONDS - 1), "in", "npub1them");
		inbox.add(message("fresh", NOW - MESSAGE_TTL_SECONDS + 60), "in", "npub1them");
		inbox.close();

		inbox = PhoneFriendDb.open(line, () => now);

		expect(inbox.history().map((m) => m.id)).toEqual(["fresh"]);
	});

	it("deletes expired messages as new ones arrive in a long-running listener", () => {
		inbox.add(message("first", NOW), "in", "npub1them");
		now = NOW + MESSAGE_TTL_SECONDS + 1;

		inbox.add(message("later", now), "in", "npub1them");

		expect(inbox.history().map((m) => m.id)).toEqual(["later"]);
	});

	it("never stores a message that is already past the ttl", () => {
		expect(inbox.add(message("stale", NOW - MESSAGE_TTL_SECONDS - 1), "in", "npub1them")).toBe(false);
		expect(inbox.history()).toEqual([]);
	});

	it("keeps settings as JSON, and setOnce keeps the first value", () => {
		inbox.set("config", { relays: ["wss://x"] });

		expect(inbox.get("config")).toEqual({ relays: ["wss://x"] });
		expect(inbox.setOnce("nsec", "first")).toBe("first");
		expect(inbox.setOnce("nsec", "second")).toBe("first");
		inbox.unset("nsec");
		expect(inbox.get("nsec")).toBeUndefined();
	});

	it("reports the schema version it created", () => {
		const raw = new Database(line.dbPath, { readonly: true });
		const { user_version } = raw.query("PRAGMA user_version").get() as { user_version: number };
		raw.close();

		expect(user_version).toBe(1);
	});
});
