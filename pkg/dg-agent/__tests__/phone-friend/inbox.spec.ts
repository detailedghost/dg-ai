import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { Inbox, MESSAGE_TTL_SECONDS } from "../../src/phone-friend/inbox";

const NOW = 1_800_000_000;
let home: string;
let paths: DgPaths;
let now: number;
let inbox: Inbox;

function message(id: string, ts: number, text = id) {
	return { id, ts, from: "npub1them", text };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-inbox-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	now = NOW;
	inbox = Inbox.open(paths, () => now);
});

afterEach(() => {
	inbox.close();
	rmSync(home, { recursive: true, force: true });
});

describe("Inbox", () => {
	it("keeps the database private in a private dir", () => {
		expect(statSync(paths.phoneFriendDbPath).mode & 0o777).toBe(0o600);
		expect(statSync(paths.phoneFriendDir).mode & 0o777).toBe(0o700);
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

		inbox = Inbox.open(paths, () => now);

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

	it("reports the schema version it created", () => {
		const raw = new Database(paths.phoneFriendDbPath, { readonly: true });
		const { user_version } = raw.query("PRAGMA user_version").get() as { user_version: number };
		raw.close();

		expect(user_version).toBe(1);
	});
});
