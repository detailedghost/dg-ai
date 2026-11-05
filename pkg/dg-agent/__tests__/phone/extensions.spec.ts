import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19, nip59, type NostrEvent } from "nostr-tools";
import { Command } from "commander";
import {
	phoneContacts,
	phoneInbox,
	phoneNumber,
	phonePing,
	phoneSay,
	phoneStatus,
	phoneThreadNew,
	phoneVoicemail,
	phoneWatch,
	type PhoneDeps,
	registerPhoneCommands,
} from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import { addContact, numberKeyId, selfExtension, splitTarget } from "../../src/phone/store";
import { FROM_EXT_TAG, EXT_TAG, rumorBody } from "../../src/phone/thread";
import { createFakePool, type FakePool, makeHomeTracker, makePhoneDeps, parseNdjson } from "./fake-pool";

const NOW = 1_800_000_000;
let home: string;
let paths: DgPaths;
let now: number;
let db: PhoneDb;

function incoming(id: string, ts: number, ext: string | null = null) {
	return { id, ts, sender: "npub1them", contact: "npub1them", text: id, direction: "in" as const, call: 0, ext };
}

function ids(rows: { id: string }[]): string[] {
	return rows.map((row) => row.id);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-ext-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	now = NOW;
	db = PhoneDb.open(paths, () => now);
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("splitTarget", () => {
	it("splits +handle/ext into the target and its extension", () => {
		expect(splitTarget("+mary/merc")).toEqual({ target: "+mary", ext: "merc" });
		expect(splitTarget("mary")).toEqual({ target: "mary" });
		expect(splitTarget("#ops")).toEqual({ target: "#ops" });
	});

	it("refuses an extension that is not 1-32 lowercase letters, digits, or dashes", () => {
		for (const bad of ["+mary/", "+mary/Merc", "+mary/-x", "+mary/a/b", `+mary/${"a".repeat(33)}`]) {
			expect(() => splitTarget(bad)).toThrow(DgCliError);
		}
	});

	it("refuses an extension on a #group, which goes to the whole machine", () => {
		expect(() => splitTarget("#ops/merc")).toThrow("a #group goes to the whole machine; drop /merc");
	});
});

describe("selfExtension", () => {
	it("prefers --as, falls back to DG_PHONE_AS, and is undefined with neither", () => {
		expect(selfExtension("merc", { DG_PHONE_AS: "kit" })).toBe("merc");
		expect(selfExtension(undefined, { DG_PHONE_AS: "kit" })).toBe("kit");
		expect(selfExtension(undefined, { DG_PHONE_AS: "" })).toBeUndefined();
		expect(selfExtension(undefined, {})).toBeUndefined();
	});

	it("refuses a bad name from either source, naming the source", () => {
		expect(() => selfExtension("Merc", {})).toThrow('--as must be 1-32 lowercase letters, digits, or dashes, got "Merc"');
		expect(() => selfExtension(undefined, { DG_PHONE_AS: "../x" })).toThrow('DG_PHONE_AS must be 1-32 lowercase letters, digits, or dashes, got "../x"');
	});
});

describe("rumorBody extension tags", () => {
	it("reads a valid dg-ext and dg-from-ext", () => {
		const body = rumorBody({ kind: 14, content: "hi", tags: [[EXT_TAG, "merc"], [FROM_EXT_TAG, "kit"]] });
		expect(body).toEqual({ text: "hi", ext: "merc", fromExt: "kit" });
	});

	it("drops a tag value that fails the name rule, so the row is shared", () => {
		for (const bad of ["../etc", "Merc", "", "a b", "x".repeat(33), "$(id)"]) {
			const body = rumorBody({ kind: 14, content: "hi", tags: [[EXT_TAG, bad], [FROM_EXT_TAG, bad]] });
			expect(body).toEqual({ text: "hi" });
		}
	});
});

describe("PhoneDb extensions", () => {
	it("stores ext and peer_ext on a message row", () => {
		db.addMessage({ ...incoming("a", NOW), peer_ext: "kit" });
		expect(db.getMessage("a")).toMatchObject({ ext: null, peer_ext: "kit" });
		db.addMessage(incoming("b", NOW, "merc"));
		expect(db.getMessage("b")).toMatchObject({ ext: "merc", peer_ext: null });
	});

	it("shows the shared view only shared rows, and an extension its rows plus shared rows", () => {
		db.addMessage(incoming("shared", NOW - 3));
		db.addMessage(incoming("merc", NOW - 2, "merc"));
		db.addMessage(incoming("kit", NOW - 1, "kit"));

		expect(ids(db.unreadFor(null))).toEqual(["shared"]);
		expect(ids(db.unreadFor("merc"))).toEqual(["shared", "merc"]);
		expect(ids(db.unreadFor("kit"))).toEqual(["shared", "kit"]);
	});

	it("keeps a shared row unread for other extensions and the shared view after one extension reads it", () => {
		db.addMessage(incoming("shared", NOW - 2));
		db.addMessage(incoming("merc", NOW - 1, "merc"));

		expect(ids(db.takeUnreadFor("merc"))).toEqual(["shared", "merc"]);
		expect(ids(db.unreadFor("merc"))).toEqual([]);
		expect(ids(db.unreadFor("kit"))).toEqual(["shared"]);
		expect(ids(db.unreadFor(null))).toEqual(["shared"]);
		expect(db.getMessage("shared")?.read_at).toBeNull();
	});

	it("marks the shared view read through read_at without touching any extension", () => {
		db.addMessage(incoming("shared", NOW - 1));

		expect(ids(db.takeUnreadFor(null))).toEqual(["shared"]);
		expect(db.getMessage("shared")?.read_at).toBe(NOW);
		expect(ids(db.unreadFor("merc"))).toEqual(["shared"]);
	});

	it("skips the given ids without marking them read", () => {
		db.addMessage(incoming("a", NOW - 2, "merc"));
		db.addMessage(incoming("b", NOW - 1, "merc"));

		expect(ids(db.takeUnreadFor("merc", new Set(["a"])))).toEqual(["b"]);
		expect(ids(db.unreadFor("merc"))).toEqual(["a"]);
	});

	it("counts unread rows waiting for each extension", () => {
		db.addMessage(incoming("m1", NOW - 3, "merc"));
		db.addMessage(incoming("m2", NOW - 2, "merc"));
		db.addMessage(incoming("k1", NOW - 1, "kit"));
		db.addMessage(incoming("shared", NOW));
		expect(db.waitingByExtension()).toEqual({ kit: 1, merc: 2 });

		db.takeUnreadFor("merc");
		expect(db.waitingByExtension()).toEqual({ kit: 1 });
	});

	it("makes a finished image unread again for every extension", () => {
		db.addMessage(incoming("img", NOW - 1));
		db.takeUnreadFor("merc");
		db.finishImage("img", "[image]", null);
		expect(ids(db.unreadFor("merc"))).toEqual(["img"]);
	});

	it("drops per-extension read marks with their row", () => {
		db.addMessage(incoming("old", NOW - 1, "merc"));
		db.takeUnreadFor("merc");
		now = NOW + 8 * 24 * 60 * 60;
		db.pruneMessages();
		expect(db.getMessage("old")).toBeUndefined();
		expect(db.waitingByExtension()).toEqual({});
	});

	it("filters stored messages by view and reports each extension's own read state", () => {
		db.addMessage(incoming("shared", NOW - 3));
		db.addMessage(incoming("merc", NOW - 2, "merc"));
		db.addMessage(incoming("kit", NOW - 1, "kit"));
		db.takeUnreadFor(null);
		db.takeUnreadFor("merc");

		expect(ids(db.recentMessages(10))).toEqual(["shared", "merc", "kit"]);
		expect(ids(db.recentMessages(10, undefined, undefined, { ext: null }))).toEqual(["shared"]);
		const kit = db.recentMessages(10, undefined, undefined, { ext: "kit" });
		expect(ids(kit)).toEqual(["shared", "kit"]);
		expect(kit.map((row) => row.read_at)).toEqual([null, null]);
		const merc = db.recentMessages(10, undefined, undefined, { ext: "merc" });
		expect(merc.map((row) => row.read_at)).toEqual([NOW, NOW]);
	});

	it("records the extensions a contact used, newest first, capped at 16, and drops them with the contact", () => {
		db.putKey({ id: "default", nsec: null, in_store: 0 });
		db.insertContact({ npub: "npub1them", handle: "mary", relays: "[]", key_id: "default", added_at: NOW, via: "accept" });
		db.touchContactExt("npub1them", "merc", NOW - 5);
		db.touchContactExt("npub1them", "kit", NOW - 1);
		db.touchContactExt("npub1them", "merc", NOW - 9);
		expect(db.contactExts("npub1them")).toEqual([
			{ ext: "kit", last_seen: NOW - 1 },
			{ ext: "merc", last_seen: NOW - 5 },
		]);

		for (let index = 0; index < 20; index++) db.touchContactExt("npub1them", `e${index}`, NOW + index);
		const kept = db.contactExts("npub1them");
		expect(kept).toHaveLength(16);
		expect(kept[0]).toEqual({ ext: "e19", last_seen: NOW + 19 });

		db.removeContact("npub1them");
		expect(db.contactExts("npub1them")).toEqual([]);
	});

	it("ignores an extension for a pubkey that is not a contact", () => {
		db.touchContactExt("npub1stranger", "merc", NOW);
		expect(db.contactExts("npub1stranger")).toEqual([]);
	});

	it("records a vault item's extension and lists shared items plus one extension's", () => {
		const item = (id: string, name: string, ext: string | null) => ({
			id,
			name,
			sender: "self",
			type: "text",
			size: 1,
			key_day: "2027-01-15",
			created_at: NOW,
			expires_at: NOW + 60,
			ext,
		});
		db.addVaultItem(item("a".repeat(32), "shared", null));
		db.addVaultItem(item("b".repeat(32), "for-merc", "merc"));
		db.addVaultItem(item("c".repeat(32), "for-kit", "kit"));

		expect(db.listVaultItems().map((row) => row.name)).toEqual(["for-kit", "for-merc", "shared"]);
		expect(db.listVaultItems("merc").map((row) => row.name)).toEqual(["for-merc", "shared"]);
		expect(db.vaultItem("for-merc")?.ext).toBe("merc");
	});
});

describe("sending to an extension", () => {
	let tracker: ReturnType<typeof makeHomeTracker>;
	let pool: FakePool;
	let out: string[];

	beforeEach(() => {
		tracker = makeHomeTracker("dg-phone-ext-send-");
		pool = createFakePool();
		out = [];
	});

	afterEach(() => {
		tracker.cleanup();
	});

	async function sender(env: Record<string, string | undefined> = {}): Promise<{ d: PhoneDeps; marySk: Uint8Array }> {
		const d: PhoneDeps = { ...makePhoneDeps({ home: tracker.freshHome(), pool, write: (text) => out.push(text), now: NOW }), env, sleep: async () => {} };
		tracker.trackDb(d.db);
		await phoneNumber({}, d);
		const marySk = generateSecretKey();
		addContact(d.db, { npub: nip19.npubEncode(getPublicKey(marySk)), handle: "mary", relays: ["wss://a.example"], keyId: numberKeyId(d.db), addedAt: NOW, via: "accept" });
		out = [];
		return { d, marySk };
	}

	function rumorTo(sk: Uint8Array): { kind: number; tags: string[][] } {
		const wrap = pool.events.findLast((event) => event.tags.some(([name, value]) => name === "p" && value === getPublicKey(sk)));
		return nip59.unwrapEvent(wrap as NostrEvent, sk);
	}

	it("tags text to +handle/ext with dg-ext inside the rumor, keeps the wrap free of it, and stores the target", async () => {
		const { d, marySk } = await sender();

		await phoneSay("+mary/merc", "hi merc", d);

		const wrap = pool.events.at(-1) as NostrEvent;
		expect(JSON.stringify(wrap.tags)).not.toContain("merc");
		expect(rumorTo(marySk).tags).toEqual([["p", getPublicKey(marySk)], [EXT_TAG, "merc"]]);
		expect(parseNdjson(out)[0]).toMatchObject({ handle: "+mary/merc" });
		expect(d.db.recentMessages(5)[0]).toMatchObject({ direction: "out", ext: null, peer_ext: "merc", text: "hi merc" });
	});

	it("sends a plain NIP-17 message with no dg tags to +handle", async () => {
		const { d, marySk } = await sender();

		await phoneSay("+mary", "hi all", d);

		expect(rumorTo(marySk).tags).toEqual([["p", getPublicKey(marySk)]]);
		expect(parseNdjson(out)[0]).toMatchObject({ handle: "+mary" });
	});

	it("carries the sender's own extension as dg-from-ext from --as, then from DG_PHONE_AS", async () => {
		const { d, marySk } = await sender({ DG_PHONE_AS: "kit" });

		await phoneSay("+mary/merc", "from kit", d);
		expect(rumorTo(marySk).tags).toEqual([["p", getPublicKey(marySk)], [EXT_TAG, "merc"], [FROM_EXT_TAG, "kit"]]);
		expect(d.db.recentMessages(5).at(-1)).toMatchObject({ ext: "kit", peer_ext: "merc" });

		await phoneSay("+mary", "from ace", d, { as: "ace", phi: true });
		expect(rumorTo(marySk).tags).toEqual([["p", getPublicKey(marySk)], ["dg-phi", "1"], [FROM_EXT_TAG, "ace"]]);
	});

	it("refuses a bad extension before anything is sent", async () => {
		const { d } = await sender();

		await expect(phoneSay("+mary/Merc", "x", d)).rejects.toThrow('an extension must be 1-32 lowercase letters, digits, or dashes, got "Merc"');
		await expect(phoneSay("+mary", "x", d, { as: "a/b" })).rejects.toThrow("--as must be");
		expect(pool.events).toEqual([]);
	});

	it("refuses an extension on a #group send, and keeps a group row machine-wide when the sender has one", async () => {
		const { d, marySk } = await sender();
		await phoneThreadNew("#ops", ["+mary"], {}, d);

		await expect(phoneSay("#ops/merc", "x", d)).rejects.toThrow("a #group goes to the whole machine; drop /merc");
		expect(pool.events).toEqual([]);

		await phoneSay("#ops", "to the room", d, { as: "kit" });
		const rumor = rumorTo(marySk);
		expect(rumor.tags.filter(([name]) => name === EXT_TAG)).toEqual([]);
		expect(rumor.tags.filter(([name]) => name === FROM_EXT_TAG)).toEqual([[FROM_EXT_TAG, "kit"]]);
		expect(d.db.recentMessages(5).at(-1)).toMatchObject({ ext: null, peer_ext: null });
	});

	it("pings +handle/ext with dg-ext on the check, and refuses #group/ext", async () => {
		const { d, marySk } = await sender();

		await phonePing("+mary/merc", { timeout: "1" }, d);
		const rumor = rumorTo(marySk);
		expect(rumor.kind).toBe(25017);
		expect(rumor.tags.filter(([name]) => name === EXT_TAG)).toEqual([[EXT_TAG, "merc"]]);
		expect(parseNdjson(out).at(-1)).toMatchObject({ handle: "+mary/merc", delivered: false });
		process.exitCode = 0;

		await expect(phonePing("#ops/merc", {}, d)).rejects.toThrow("a #group goes to the whole machine; drop /merc");
	});
});

describe("reading by extension", () => {
	let tracker: ReturnType<typeof makeHomeTracker>;
	let out: string[];
	let d: PhoneDeps;
	let mary: string;

	beforeEach(async () => {
		tracker = makeHomeTracker("dg-phone-ext-read-");
		out = [];
		d = { ...makePhoneDeps({ home: tracker.freshHome(), pool: createFakePool(), write: (text) => out.push(text), now: NOW }), sleep: async () => {} };
		tracker.trackDb(d.db);
		await phoneNumber({}, d);
		mary = nip19.npubEncode(getPublicKey(generateSecretKey()));
		addContact(d.db, { npub: mary, handle: "mary", relays: ["wss://a.example"], keyId: numberKeyId(d.db), addedAt: NOW, via: "accept" });
		const add = (id: string, ts: number, ext: string | null = null, peer_ext: string | null = null) =>
			d.db.addMessage({ id, ts, sender: mary, contact: mary, text: id, direction: "in", call: 0, ext, peer_ext });
		add("shared", NOW - 3);
		add("for-merc", NOW - 2, "merc", "ace");
		add("for-kit", NOW - 1, "kit");
		out = [];
	});

	afterEach(() => {
		tracker.cleanup();
	});

	function printed(): Record<string, unknown>[] {
		const rows = parseNdjson(out) as Record<string, unknown>[];
		out = [];
		return rows;
	}

	it("shows the shared view only shared rows, then one line counting rows that wait for each agent", async () => {
		await phoneVoicemail(d);

		const rows = printed();
		expect(rows.map((row) => row.text ?? row.waiting)).toEqual(["shared", { kit: 1, merc: 1 }]);
		expect(rows[1]?.line).toBe("2 unread for other agents: kit 1, merc 1; read them with --as <ext>");
		await phoneVoicemail(d);
		expect(printed()).toEqual([{ waiting: { kit: 1, merc: 1 }, line: "2 unread for other agents: kit 1, merc 1; read them with --as <ext>" }]);
	});

	it("shows an agent its own rows and the shared ones once, with ext, from_ext, and a reply handle", async () => {
		await phoneVoicemail(d, { as: "merc" });

		const rows = printed();
		expect(rows.map((row) => row.text)).toEqual(["shared", "for-merc"]);
		expect(rows[0]).toMatchObject({ handle: "+mary" });
		expect(rows[0]?.ext).toBeUndefined();
		expect(rows[1]).toMatchObject({ handle: "+mary/ace", ext: "merc", from_ext: "ace", from: mary });

		await phoneVoicemail(d, { as: "merc" });
		expect(printed()).toEqual([]);
		await phoneVoicemail({ ...d, env: { DG_PHONE_AS: "kit" } });
		expect(printed().map((row) => row.text)).toEqual(["shared", "for-kit"]);
		await phoneVoicemail(d);
		expect(printed().map((row) => row.text ?? row.waiting)).toEqual(["shared"]);
	});

	it("prints stored messages per view, with each agent's own read state, and never marks anything read", async () => {
		await phoneVoicemail(d, { as: "merc" });
		out = [];

		phoneInbox({}, d);
		const shared = printed();
		expect(shared.map((row) => row.text ?? row.waiting)).toEqual(["shared", { kit: 1 }]);
		expect(shared[0]?.read).toBe(false);

		phoneInbox({ as: "merc" }, d);
		expect(printed().map((row) => [row.text, row.read])).toEqual([
			["shared", true],
			["for-merc", true],
		]);
		phoneInbox({ handle: "+mary", as: "kit" }, d);
		expect(printed().map((row) => [row.text, row.read])).toEqual([
			["shared", false],
			["for-kit", false],
		]);
	});

	it("counts unread rows across every view in status, and stops counting a row its agent read", async () => {
		const pending = async () => {
			await phoneStatus(d);
			return printed()[0]?.pending_voicemail;
		};
		expect(await pending()).toBe(3);
		await phoneVoicemail(d, { as: "merc" });
		out = [];
		expect(await pending()).toBe(2);
	});

	it("filters messages by contact when given +handle/ext, the handle form rows print", async () => {
		phoneInbox({ handle: "+mary/ace", as: "merc" }, d);
		expect(printed().map((row) => row.text)).toEqual(["shared", "for-merc"]);
	});

	it("passes --as from the command line to unread and messages", async () => {
		const program = new Command().exitOverride();
		registerPhoneCommands(program, () => d);

		await program.parseAsync(["phone", "unread", "--as", "merc"], { from: "user" });
		expect(printed().map((row) => row.text)).toEqual(["shared", "for-merc"]);
		await program.parseAsync(["phone", "messages", "--as", "kit"], { from: "user" });
		expect(printed().map((row) => row.text)).toEqual(["shared", "for-kit"]);
	});

	it("watches one agent's view and its --new skip set", async () => {
		let clock = NOW;
		const ticking: PhoneDeps = { ...d, now: () => clock, sleep: async (ms) => void (clock += Math.ceil(ms / 1000)) };
		await phoneWatch({ for: "1", as: "merc" }, ticking);
		expect(printed().map((row) => row.text)).toEqual(["shared", "for-merc"]);

		await phoneWatch({ for: "1", new: true, as: "kit" }, ticking);
		expect(printed()).toEqual([]);
		expect(d.db.unreadFor("kit").map((row) => row.id)).toEqual(["shared", "for-kit"]);
	});

	it("lists the extensions each contact used, newest first, only when there are some", async () => {
		d.db.touchContactExt(mary, "ace", NOW - 60);
		d.db.touchContactExt(mary, "bo", NOW);

		phoneContacts(d);

		expect(printed()[0]?.extensions).toEqual([
			{ ext: "bo", last_seen: new Date(NOW * 1000).toISOString() },
			{ ext: "ace", last_seen: new Date((NOW - 60) * 1000).toISOString() },
		]);
		d.db.removeContact(mary);
		addContact(d.db, { npub: mary, handle: "mary", relays: [], keyId: numberKeyId(d.db), addedAt: NOW, via: "accept" });
		phoneContacts(d);
		expect(printed()[0]?.extensions).toBeUndefined();
	});
});
