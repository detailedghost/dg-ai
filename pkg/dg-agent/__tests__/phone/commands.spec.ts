import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { Command } from "commander";
import { generateSecretKey, getPublicKey, nip17, nip19 } from "nostr-tools";
import { decodeCard } from "../../src/phone/card";
import { type KeyEntry, ring, unwrapIncoming } from "../../src/phone/chat";
import {
	phoneAccept,
	phoneContacts,
	phoneContactsRemove,
	phoneContactsRename,
	phoneInbox,
	phoneInvite,
	phoneNumber,
	phoneSay,
	phoneStatus,
	phoneVoicemail,
	type PhoneDeps,
	registerPhoneCommands,
} from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import { createFileKey, ensureNumberKey } from "../../src/phone/keys";
import { listenerPidPath } from "../../src/phone/listener";
import {
	addContact,
	type ContactRecord,
	DEFAULT_RELAYS,
	gateFor,
	listContacts,
	liveInvites,
	numberKeyId,
	readRelays,
	removeContact,
	subscriptionRelays,
	writeListener,
} from "../../src/phone/store";
import { createFakePool, freshNpub as realNpub, makeHomeTracker, makePhoneDeps, parseNdjson, type FakePool } from "./fake-pool";

let tracker: ReturnType<typeof makeHomeTracker>;
let out: string[];
let pool: FakePool;
const NOW = Math.floor(Date.now() / 1000);

function deps(home: string, poolOverride: FakePool = pool): PhoneDeps {
	const d = makePhoneDeps({ home, pool: poolOverride, write: (text) => out.push(text), now: NOW });
	tracker.trackDb(d.db);
	return d;
}

function freshHome(): string {
	return tracker.freshHome();
}

function lines(): unknown[] {
	return parseNdjson(out);
}

function addTestContact(db: PhoneDb, overrides: Partial<ContactRecord> = {}): ContactRecord {
	const record: ContactRecord = {
		npub: realNpub(),
		handle: "velora",
		relays: ["wss://a.example"],
		keyId: numberKeyId(db),
		addedAt: NOW,
		via: "accept",
		...overrides,
	};
	addContact(db, record);
	return record;
}

beforeEach(() => {
	tracker = makeHomeTracker("dg-phone-cli-");
	out = [];
	pool = createFakePool();
});

afterEach(() => {
	tracker.cleanup();
});

describe("number", () => {
	it("creates a number on first call and prints the same card on a second call", async () => {
		const d = deps(freshHome());

		await phoneNumber({}, d);
		const first = lines()[0] as { card: string; npub: string; as: string; rotated: boolean };
		out = [];
		await phoneNumber({}, d);
		const second = lines()[0] as { card: string };

		expect(first.as).toBe("dg");
		expect(first.rotated).toBe(false);
		expect(second.card).toBe(first.card);
		expect(decodeCard(first.card, NOW).npub).toBe(first.npub);
	});

	it("--rotate prints a different card and sets rotated true", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		const before = lines()[0] as { card: string };
		out = [];

		await phoneNumber({ rotate: true }, d);
		const after = lines()[0] as { card: string; rotated: boolean };

		expect(after.rotated).toBe(true);
		expect(after.card).not.toBe(before.card);
	});

	it("--as saves the self name and --relay persists the relay list, both read back by the next call", async () => {
		const d = deps(freshHome());
		await phoneNumber({ as: "dante", relay: ["wss://custom.example"] }, d);
		out = [];

		await phoneNumber({}, d);
		const printed = lines()[0] as { as: string; relays: string[] };

		expect(printed.as).toBe("dante");
		expect(printed.relays).toEqual(["wss://custom.example"]);
	});

	it("never carries an expiry", async () => {
		const d = deps(freshHome());

		await phoneNumber({}, d);

		expect((lines()[0] as { expires_at: null }).expires_at).toBeNull();
	});

	it("reports the live listener from the pid file, and null when none is running", async () => {
		const d = deps(freshHome());

		await phoneNumber({}, d);
		expect(lines()[0]).toMatchObject({ listener: null });

		writeFileSync(listenerPidPath(d.paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null }));
		out = [];
		await phoneNumber({}, d);

		expect(lines()[0]).toMatchObject({ listener: { pid: process.pid, since: NOW } });
	});

	it("rejects a bad --as", async () => {
		const d = deps(freshHome());

		await expect(phoneNumber({ as: "Not Ok" }, d)).rejects.toThrow(DgCliError);
	});
});

describe("invite", () => {
	it("prints a card whose secret and expiry are a fresh one-time invite", async () => {
		const d = deps(freshHome());

		await phoneInvite({}, d);
		const printed = lines()[0] as { card: string; expires_at: string; as: string; handle: string | null };
		const decoded = decodeCard(printed.card, NOW);

		expect(decoded.exp).toBe(NOW + 24 * 3600);
		expect(printed.expires_at).toBe(new Date((NOW + 24 * 3600) * 1000).toISOString());
		expect(printed.as).toBe("dg");
		expect(printed.handle).toBeNull();
	});

	it("saves --relay on the invite and adds it to the listener subscription without changing the number relays", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		out = [];

		await phoneInvite({ relay: ["wss://invite.example"] }, d);

		const printed = lines()[0] as { card: string };
		expect(decodeCard(printed.card, NOW).relays).toEqual(["wss://invite.example"]);
		expect(readRelays(d.db)).toEqual(DEFAULT_RELAYS);
		expect(liveInvites(d.db)[0]?.relays).toEqual(["wss://invite.example"]);
		expect(subscriptionRelays(d.db)).toEqual([...DEFAULT_RELAYS, "wss://invite.example"]);
	});

	it("--name pre-assigns the contact's handle and reports it", async () => {
		const d = deps(freshHome());

		await phoneInvite({ name: "grok" }, d);

		expect((lines()[0] as { handle: string }).handle).toBe("+grok");
	});

	it("rejects a ttl that is not a positive number of hours", async () => {
		const d = deps(freshHome());

		await expect(phoneInvite({ ttl: "0" }, d)).rejects.toThrow('ttl must be a positive number of hours, got "0"');
		await expect(phoneInvite({ ttl: "soon" }, d)).rejects.toThrow("ttl must be a positive number of hours");
	});

	it("rejects --name already used by a contact", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		out = [];
		addTestContact(d.db, { handle: "grok" });

		await expect(phoneInvite({ name: "grok" }, d)).rejects.toThrow('"grok" is already used by +grok');
	});
});

describe("accept", () => {
	it("admits a fresh contact from the new card; the pre-rotate card's secret no longer admits", async () => {
		const owner = deps(freshHome());
		await phoneNumber({}, owner);
		const oldCard = (lines()[0] as { card: string }).card;
		out = [];
		await phoneNumber({ rotate: true }, owner);
		const newCard = (lines()[0] as { card: string }).card;
		out = [];

		const peer = deps(freshHome(), pool);
		await phoneAccept(newCard, "hi there", peer);
		const accepted = lines()[0] as { handle: string; npub: string };
		expect(accepted.handle).toBe("+dg");

		const [ringEvent] = pool.events;
		const ownerKey = await ensureNumberKey(owner);
		const keyEntry: KeyEntry = { id: numberKeyId(owner.db), pub: getPublicKey(ownerKey.sk), sk: ownerKey.sk };
		const ownerGate = gateFor(owner.db);

		const admittedNew = unwrapIncoming(ringEvent, [keyEntry], ownerGate, NOW);
		expect(admittedNew?.message.call).toBe(true);
		expect(admittedNew?.newContact).toMatchObject({ via: "number" });

		const oldSecret = decodeCard(oldCard, NOW).secret;
		expect(oldSecret).not.toBe(decodeCard(newCard, NOW).secret);
		const anotherCaller = generateSecretKey();
		const staleRing = ring("too late", anotherCaller, getPublicKey(ownerKey.sk), oldSecret, "latecomer");

		expect(unwrapIncoming(staleRing, [keyEntry], ownerGate, NOW)).toBeNull();
	});

	it("removes the contact it just added when no relay accepts", async () => {
		const owner = deps(freshHome());
		await phoneNumber({}, owner);
		const card = (lines()[0] as { card: string }).card;
		out = [];

		const peer = deps(freshHome(), createFakePool([]));

		await expect(phoneAccept(card, "hi", peer)).rejects.toThrow("no relay accepted the call");
		expect(listContacts(peer.db)).toEqual([]);
	});

	it("re-accepting a contact it already holds upserts relays and keeps the handle", async () => {
		const owner = deps(freshHome());
		await phoneNumber({}, owner);
		const card = (lines()[0] as { card: string }).card;
		out = [];
		const peer = deps(freshHome(), pool);
		await phoneAccept(card, "hi", peer);
		const firstHandle = (lines()[0] as { handle: string }).handle;
		out = [];

		await phoneAccept(card, "hi again", peer);
		const secondHandle = (lines()[0] as { handle: string }).handle;

		expect(secondHandle).toBe(firstHandle);
		expect(listContacts(peer.db)).toHaveLength(1);
	});

	it("fails on a v1 card, which carries no handle", async () => {
		const peer = deps(freshHome());
		const npub = realNpub();
		const v1 = `dgcall1${Buffer.from(
			JSON.stringify({ v: 1, npub, relays: ["wss://a.example"], secret: "ab".repeat(32), exp: 9_999_999_999 }),
		).toString("base64url")}`;

		await expect(phoneAccept(v1, "hi", peer)).rejects.toThrow("no handle");
	});

	it("errors with 'no call card given' on empty stdin", async () => {
		const peer = deps(freshHome());

		await expect(phoneAccept("-", undefined, peer)).rejects.toThrow("no call card given");
	});

	it("errors on an expired card", async () => {
		const owner = deps(freshHome());
		await phoneInvite({ ttl: "1" }, owner);
		const card = (lines()[0] as { card: string }).card;
		const peer = deps(freshHome());
		peer.now = () => NOW + 3601;

		await expect(phoneAccept(card, "hi", peer)).rejects.toThrow("expired");
	});
});

describe("say", () => {
	it("signs with the contact's key_id and publishes to the contact's relays", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		out = [];
		addTestContact(d.db, { handle: "aaa", relays: ["wss://a.example"] });
		addTestContact(d.db, { handle: "bbb", relays: ["wss://b.example"] });

		await phoneSay("+aaa", "hello first", d);
		const first = lines()[0] as { handle: string; id: string; relays_ok: string[] };
		out = [];
		await phoneSay("+bbb", "hello second", d);
		const second = lines()[0] as { handle: string; id: string; relays_ok: string[] };

		expect(first).toMatchObject({ handle: "+aaa", relays_ok: ["wss://a.example"] });
		expect(second).toMatchObject({ handle: "+bbb", relays_ok: ["wss://b.example"] });
		expect(first.id).not.toBe(second.id);
	});

	it("signs with a legacy key_id, not the number key, so an old peer's one-npub gate keeps accepting us", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		out = [];
		const legacySk = createFileKey(d.db, "work") as Uint8Array;
		const contactSk = generateSecretKey();
		addTestContact(d.db, { npub: nip19.npubEncode(getPublicKey(contactSk)), handle: "velora", keyId: "work" });

		await phoneSay("+velora", "hi", d);

		const [sentEvent] = pool.events;
		const rumor = nip17.unwrapEvent(sentEvent, contactSk);
		const numberKey = await ensureNumberKey(d);
		expect(rumor.pubkey).toBe(getPublicKey(legacySk));
		expect(rumor.pubkey).not.toBe(getPublicKey(numberKey.sk));
	});

	it("fails on an unknown handle", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);

		await expect(phoneSay("+nobody", "hi", d)).rejects.toThrow("no contact +nobody");
	});

	it("fails on empty text", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		addTestContact(d.db);

		await expect(phoneSay("+velora", "", d)).rejects.toThrow("message text is empty");
	});

	it("reads text from stdin when given -", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		addTestContact(d.db);
		d.readStdin = async () => "from stdin\n";
		out = [];

		await phoneSay("+velora", "-", d);

		expect(lines()[0]).toMatchObject({ handle: "+velora" });
	});
});

describe("inbox", () => {
	it("prints oldest first, defaults to 50, and never marks anything read", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		addTestContact(d.db, { npub: "npub1a", handle: "velora" });
		d.db.addMessage({ id: "m1", direction: "in", ts: NOW + 1, sender: "npub1a", contact: "npub1a", text: "one", call: 0 });
		d.db.addMessage({ id: "m2", direction: "in", ts: NOW + 2, sender: "npub1a", contact: "npub1a", text: "two", call: 0 });
		out = [];

		phoneInbox({}, d);
		const rows = lines() as { id: string; read: boolean; handle: string | null }[];

		expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
		expect(rows.every((r) => r.read === false)).toBe(true);
		expect(rows.every((r) => r.handle === "+velora")).toBe(true);
	});

	it("-n 2 with a handle filter returns the last two rows for that contact only, oldest first", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		addTestContact(d.db, { npub: "npub1a", handle: "velora" });
		addTestContact(d.db, { npub: "npub1b", handle: "other" });
		d.db.addMessage({ id: "a1", direction: "in", ts: NOW + 1, sender: "npub1a", contact: "npub1a", text: "one", call: 0 });
		d.db.addMessage({ id: "b1", direction: "in", ts: NOW + 2, sender: "npub1b", contact: "npub1b", text: "x", call: 0 });
		d.db.addMessage({ id: "a2", direction: "in", ts: NOW + 3, sender: "npub1a", contact: "npub1a", text: "two", call: 0 });
		d.db.addMessage({ id: "a3", direction: "in", ts: NOW + 4, sender: "npub1a", contact: "npub1a", text: "three", call: 0 });
		out = [];

		phoneInbox({ n: "2", handle: "+velora" }, d);
		const rows = lines() as { id: string }[];
		out = [];
		phoneInbox({ n: "2", handle: "+velora" }, d);
		const secondRead = lines() as { read: boolean }[];

		expect(rows.map((r) => r.id)).toEqual(["a2", "a3"]);
		expect(secondRead.every((r) => r.read === false)).toBe(true);
	});

	it("fails on an unknown handle", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);

		expect(() => phoneInbox({ handle: "+nobody" }, d)).toThrow("no contact +nobody");
	});

	it("prints handle null for a message whose contact has since been removed", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		addTestContact(d.db, { npub: "npub1a", handle: "velora" });
		d.db.addMessage({ id: "m1", direction: "in", ts: NOW, sender: "npub1a", contact: "npub1a", text: "hi", call: 0 });
		removeContact(d.db, "velora");
		out = [];

		phoneInbox({}, d);

		expect((lines()[0] as { handle: string | null }).handle).toBeNull();
	});
});

describe("voicemail", () => {
	it("prints unread incoming rows oldest first and marks them read", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		out = [];
		d.db.addMessage({ id: "b", direction: "in", ts: NOW + 2, sender: "npub1x", contact: "npub1x", text: "b", call: 0 });
		d.db.addMessage({ id: "a", direction: "in", ts: NOW + 1, sender: "npub1x", contact: "npub1x", text: "a", call: 0 });

		phoneVoicemail(d);
		const first = lines() as { id: string }[];
		out = [];
		phoneVoicemail(d);

		expect(first.map((r) => r.id)).toEqual(["a", "b"]);
		expect(lines()).toEqual([]);
	});
});

describe("contacts", () => {
	it("lists in handle order, renames, and removes", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		out = [];
		addTestContact(d.db, { npub: "npub1b", handle: "bbb" });
		addTestContact(d.db, { npub: "npub1a", handle: "aaa" });

		phoneContacts(d);
		expect((lines() as { handle: string }[]).map((c) => c.handle)).toEqual(["+aaa", "+bbb"]);
		out = [];

		phoneContactsRename("+aaa", "ccc", d);
		expect(lines()[0]).toEqual({ handle: "+ccc", renamed_from: "+aaa" });
		out = [];

		phoneContactsRemove("+ccc", d);
		expect(lines()[0]).toEqual({ removed: "+ccc" });
	});

	it("fails rename on a taken target and remove on an unknown handle", async () => {
		const d = deps(freshHome());
		await phoneNumber({}, d);
		addTestContact(d.db, { npub: "npub1a", handle: "aaa" });
		addTestContact(d.db, { npub: "npub1b", handle: "bbb" });

		expect(() => phoneContactsRename("aaa", "bbb", d)).toThrow('"bbb" is already used by +bbb');
		expect(() => phoneContactsRemove("ghost", d)).toThrow("no contact +ghost");
	});
});

describe("status", () => {
	it("reflects the self name, contact count, and pending voicemail count", async () => {
		const d = deps(freshHome());
		await phoneNumber({ as: "dante" }, d);
		out = [];
		addTestContact(d.db, { npub: "npub1a", handle: "aaa" });
		d.db.addMessage({ id: "m1", direction: "in", ts: NOW, sender: "npub1a", contact: "npub1a", text: "hi", call: 0 });

		phoneStatus(d);

		expect(lines()[0]).toEqual({
			as: "dante",
			contacts: 1,
			pending_voicemail: 1,
			listener: null,
			hook: null,
			legacy_root_present: false,
			migration_pending: false,
			autostart: null,
		});
	});

	it("reports the running listener and its hook from the pid file, and null once the pid is dead", () => {
		const d = deps(freshHome());
		writeFileSync(
			listenerPidPath(d.paths),
			JSON.stringify({ pid: process.pid, since: NOW, hook: { argv: ["notify-send"], timeoutS: 30 } }),
		);

		phoneStatus(d);

		expect(lines()[0]).toMatchObject({
			listener: { pid: process.pid, since: NOW },
			hook: { kind: "command", argv: ["notify-send"], timeout_s: 30 },
		});

		out = [];
		writeFileSync(listenerPidPath(d.paths), JSON.stringify({ pid: 999_999_999, since: NOW, hook: null }));

		phoneStatus(d);

		expect(lines()[0]).toMatchObject({ listener: null, hook: null });
	});

	it("flags legacy_root_present when the old phone-friend root is still sitting next to phone.db", () => {
		const home = freshHome();
		const d = deps(home);
		mkdirSync(join(d.paths.phoneFriendRoot, "default"), { recursive: true });
		writeFileSync(join(d.paths.phoneFriendRoot, "default", "phone-friend.db"), "");

		phoneStatus(d);

		expect(lines()[0]).toMatchObject({ legacy_root_present: true });
	});

	it("reports the autostart kind or unavailable reason last saved by open", () => {
		const d = deps(freshHome());
		writeListener(d.db, { autostart: { kind: "systemd" } });

		phoneStatus(d);

		expect(lines()[0]).toMatchObject({ autostart: "systemd" });

		out = [];
		writeListener(d.db, { autostart: { kind: "unavailable", reason: "no systemd user bus" } });

		phoneStatus(d);

		expect(lines()[0]).toMatchObject({ autostart: "unavailable: no systemd user bus" });
	});
});

describe("--line is gone", () => {
	it("fails fast with the replacement message, before dispatching to any subcommand", async () => {
		const program = new Command();
		registerPhoneCommands(program, () => deps(freshHome()));
		program.exitOverride();

		await expect(program.parseAsync(["phone", "--line", "x", "number"], { from: "user" })).rejects.toThrow(
			"--line is gone: one phone holds every contact; use +handle on say and inbox",
		);
	});
});
