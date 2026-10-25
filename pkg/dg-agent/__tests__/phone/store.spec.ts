import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { nip19 } from "nostr-tools";
import { PhoneDb } from "../../src/phone/db";
import {
	addContact,
	addInvite,
	clearListener,
	consumeInvite,
	DEFAULT_NUMBER_KEY_ID,
	DEFAULT_RELAYS,
	findContactByHandle,
	findContactByNpub,
	gateFor,
	isHandle,
	liveInvites,
	nextFreeHandle,
	normalizeHandle,
	numberKeyId,
	readCursor,
	readListener,
	readNumber,
	readRelays,
	removeContact,
	renameContact,
	requireFreeHandle,
	resolvedSelfName,
	setContactKeyId,
	writeCursor,
	writeListener,
	writeNumber,
	writeRelays,
} from "../../src/phone/store";
import { freshNpub as npub, makeTempHome } from "./fake-pool";

let home: string;
let paths: DgPaths;
let db: PhoneDb;
const NOW = 1_800_000_000;

beforeEach(() => {
	home = makeTempHome("dg-phone-store-");
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	db = PhoneDb.open(paths, () => NOW);
	db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
	db.ensureKeyRow("work", () => ({ nsec: null, in_store: 1 }));
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("isHandle", () => {
	it("accepts 1-32 lowercase letters, digits, or dashes starting with a letter or digit", () => {
		for (const bad of ["", "Default", "de fault", "../etc", "a".repeat(33), "-x", "has/slash", "has@at"]) {
			expect(isHandle(bad)).toBe(false);
		}
		expect(isHandle("velora")).toBe(true);
		expect(isHandle("a-b-2")).toBe(true);
	});
});

describe("normalizeHandle", () => {
	it("strips a leading +, and leaves a bare handle alone", () => {
		expect(normalizeHandle("+velora")).toBe("velora");
		expect(normalizeHandle("velora")).toBe("velora");
	});
});

describe("number", () => {
	it("defaults to the neutral self name and the three public relays before anything is saved", () => {
		expect(readNumber(db)).toBeUndefined();
		expect(resolvedSelfName(db)).toBe("dg");
		expect(readRelays(db)).toEqual(DEFAULT_RELAYS);
		expect(DEFAULT_RELAYS).toHaveLength(3);
	});

	it("round-trips a saved number record", () => {
		writeNumber(db, { secret: "ab".repeat(32), as: "dante" });

		expect(readNumber(db)).toEqual({ secret: "ab".repeat(32), as: "dante" });
		expect(resolvedSelfName(db)).toBe("dante");
	});

	it("round-trips a custom relay list", () => {
		writeRelays(db, ["wss://x.example"]);

		expect(readRelays(db)).toEqual(["wss://x.example"]);
	});

	it("picks the default key id once and keeps it for later readers", () => {
		expect(numberKeyId(db)).toBe(DEFAULT_NUMBER_KEY_ID);
		expect(numberKeyId(db)).toBe(DEFAULT_NUMBER_KEY_ID);
	});
});

describe("contacts", () => {
	it("round-trips a contact and finds it by handle or npub", () => {
		const who = npub();
		addContact(db, { npub: who, handle: "velora", relays: ["wss://a"], keyId: "default", addedAt: NOW, via: "accept" });

		expect(findContactByHandle(db, "velora")).toEqual({
			npub: who,
			handle: "velora",
			relays: ["wss://a"],
			keyId: "default",
			addedAt: NOW,
			via: "accept",
		});
		expect(findContactByNpub(db, who)?.handle).toBe("velora");
	});

	it("rejects a handle that is not free, naming the contact that holds it", () => {
		addContact(db, { npub: npub(), handle: "velora", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "accept" });

		expect(() => requireFreeHandle(db, "velora")).toThrow('"velora" is already used by +velora');
	});

	it("rejects a handle that is not a safe shape", () => {
		expect(() => requireFreeHandle(db, "Not Ok")).toThrow(DgCliError);
	});

	it("suggests base, then base-2, base-3, ... until one is free", () => {
		expect(nextFreeHandle(db, "grok")).toBe("grok");

		addContact(db, { npub: npub(), handle: "grok", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "number" });
		expect(nextFreeHandle(db, "grok")).toBe("grok-2");

		addContact(db, { npub: npub(), handle: "grok-2", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "number" });
		expect(nextFreeHandle(db, "grok")).toBe("grok-3");
	});

	it("renames a contact and refuses a taken target", () => {
		addContact(db, { npub: npub(), handle: "old", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "accept" });
		addContact(db, { npub: npub(), handle: "taken", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "accept" });

		const renamed = renameContact(db, "old", "new");
		expect(renamed.handle).toBe("new");
		expect(findContactByHandle(db, "old")).toBeUndefined();
		expect(() => renameContact(db, "new", "taken")).toThrow('"taken" is already used by +taken');
	});

	it("fails to rename an unknown handle", () => {
		expect(() => renameContact(db, "ghost", "x")).toThrow("no contact +ghost");
	});

	it("removes a contact, and fails on an unknown handle", () => {
		addContact(db, { npub: npub(), handle: "velora", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "accept" });

		expect(removeContact(db, "velora")).toMatchObject({ handle: "velora" });
		expect(findContactByHandle(db, "velora")).toBeUndefined();
		expect(() => removeContact(db, "velora")).toThrow("no contact +velora");
	});

	it("moves a contact to the key its ring was addressed to", () => {
		const who = npub();
		addContact(db, { npub: who, handle: "velora", relays: DEFAULT_RELAYS, keyId: "work", addedAt: NOW, via: "accept" });

		setContactKeyId(db, who, "default");

		expect(findContactByNpub(db, who)?.keyId).toBe("default");
	});
});

describe("invites", () => {
	it("round-trips a live invite and drops it once consumed", () => {
		const secret = "ab".repeat(32);
		addInvite(db, { secret, expiresAt: NOW + 100, asName: "dg", keyId: "default" });
		expect(liveInvites(db)).toEqual([{ secret, expiresAt: NOW + 100, asName: "dg", name: undefined, keyId: "default", relays: [] }]);

		consumeInvite(db, secret);

		expect(liveInvites(db)).toEqual([]);
	});

	it("leaves an expired invite out of the live list", () => {
		addInvite(db, { secret: "cd".repeat(32), expiresAt: NOW - 1, asName: "dg", keyId: "default" });

		expect(liveInvites(db)).toEqual([]);
	});
});

describe("gateFor", () => {
	it("builds the admission gate from the current contacts, number secret, and live invites", () => {
		const who = npub();
		addContact(db, { npub: who, handle: "velora", relays: DEFAULT_RELAYS, keyId: "default", addedAt: NOW, via: "accept" });
		writeNumber(db, { secret: "ab".repeat(32), as: "dg" });
		addInvite(db, { secret: "cd".repeat(32), expiresAt: NOW + 100, asName: "dg", name: "grok", keyId: "default" });

		const gate = gateFor(db);

		const hex = nip19.decode(who).data as string;
		expect(gate.contacts.get(hex)).toEqual({ npub: who, handle: "velora" });
		expect(gate.secrets.number).toBe("ab".repeat(32));
		expect(gate.secrets.invites).toEqual([{ secret: "cd".repeat(32), expiresAt: NOW + 100, name: "grok", relays: [] }]);
	});

	it("gives an empty-string number secret before `number` has ever run", () => {
		expect(gateFor(db).secrets.number).toBe("");
	});

	it("throws a clean DgCliError instead of a raw decode exception for a malformed contact npub", () => {
		db.putContact({ npub: "not-an-npub", handle: "broken", relays: "[]", key_id: "default", added_at: NOW, via: "accept" });

		expect(() => gateFor(db)).toThrow(DgCliError);
	});
});

describe("listener settings", () => {
	it("round-trips the hook and autostart state, and clears", () => {
		writeListener(db, { onMessage: { argv: ["notify-send"], timeoutMs: 30_000 }, autostart: { kind: "systemd" } });

		expect(readListener(db)).toEqual({ onMessage: { argv: ["notify-send"], timeoutMs: 30_000 }, autostart: { kind: "systemd" } });

		clearListener(db);

		expect(readListener(db)).toBeUndefined();
	});

	it("round-trips an unavailable autostart reason", () => {
		writeListener(db, { autostart: { kind: "unavailable", reason: "systemctl --user: command not found" } });

		expect(readListener(db)).toEqual({ autostart: { kind: "unavailable", reason: "systemctl --user: command not found" } });
	});
});

describe("cursor", () => {
	it("starts at zero and round-trips", () => {
		expect(readCursor(db)).toBe(0);

		writeCursor(db, NOW);

		expect(readCursor(db)).toBe(NOW);
	});
});
