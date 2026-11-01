import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import { encodeCard, NO_EXPIRY } from "../../src/phone/card";
import { npubOf } from "../../src/phone/chat";
import {
	phoneAccept,
	phoneContactsRename,
	phoneInbox,
	phoneNumber,
	phoneSay,
	phoneThreadList,
	phoneThreadNew,
	phoneThreadShow,
	phoneVoicemail,
	type PhoneDeps,
} from "../../src/phone/commands";
import { MESSAGE_TTL_SECONDS, PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { readFileKey, type KeyClient } from "../../src/phone/keys";
import { runListener, type ListenerDeps } from "../../src/phone/listener";
import { addContact, numberKeyId, writeRelays } from "../../src/phone/store";
import { createFakePool, makeHomeTracker, parseNdjson, type FakePool } from "./fake-pool";

const RELAYS = ["wss://a.example", "wss://b.example"];
const tracker = makeHomeTracker("dg-phone-thread-live-");
let clock = 0;
let pool: FakePool;

function homeDir(): string {
	return tracker.freshHome();
}

function phoneDeps(home: string, write: (text: string) => void = () => {}): PhoneDeps {
	const paths = resolveDgPaths({ env: { DG_HOME: home } });
	const db = PhoneDb.open(paths, () => clock);
	tracker.trackDb(db);
	return {
		paths,
		db,
		createPool: () => ({ ...pool, close() {} }),
		write,
		readStdin: async () => undefined,
		now: () => clock,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
	};
}

async function boot(name: string): Promise<{ home: string; deps: PhoneDeps; npub: string }> {
	const home = homeDir();
	const deps = phoneDeps(home);
	await phoneNumber({ as: name, relay: RELAYS }, deps);
	const sk = readFileKey(deps.db, numberKeyId(deps.db));
	if (!sk) throw new Error("missing number key");
	return { home, deps, npub: npubOf(sk) };
}

function link(left: PhoneDeps, leftHandle: string, rightNpub: string, right: PhoneDeps, rightHandle: string, leftNpub: string): void {
	addContact(left.db, {
		npub: rightNpub,
		handle: leftHandle,
		relays: RELAYS,
		keyId: numberKeyId(left.db),
		addedAt: clock,
		via: "accept",
	});
	addContact(right.db, {
		npub: leftNpub,
		handle: rightHandle,
		relays: RELAYS,
		keyId: numberKeyId(right.db),
		addedAt: clock,
		via: "accept",
	});
}

function captureShutdown(): { onSignal: ListenerDeps["onSignal"]; ready: Promise<void>; stop: () => void } {
	let stopHandler: (() => void) | undefined;
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	return {
		onSignal: (signal, handler) => {
			if (signal === "SIGTERM") {
				stopHandler = handler;
				resolveReady();
			}
		},
		ready,
		stop: () => stopHandler?.(),
	};
}

function listen(deps: PhoneDeps, pid: number): { run: Promise<void>; ready: Promise<void>; stop: () => void } {
	const harness = captureShutdown();
	const listener: ListenerDeps = {
		paths: deps.paths,
		db: deps.db,
		sessionClient: deps.sessionClient,
		grantClient: deps.grantClient,
		createPool: () => ({ ...pool, close() {} }),
		now: () => clock,
		pid,
		schedule: (() => () => {}) as Schedule,
		onSignal: harness.onSignal,
	};
	return { run: runListener(listener), ready: harness.ready, stop: harness.stop };
}

function rows(deps: PhoneDeps, handle?: string): { id: string; text?: string; line?: string; thread?: string; handle: string | null; direction?: string }[] {
	const printed: string[] = [];
	const previous = deps.write;
	deps.write = (text) => printed.push(text);
	phoneInbox(handle === undefined ? {} : { handle }, deps);
	deps.write = previous;
	return parseNdjson(printed) as { id: string; text?: string; line?: string; thread?: string; handle: string | null; direction?: string }[];
}

afterEach(() => {
	tracker.cleanup();
});

describe("phone threads", () => {
	it("stores each of three sends once, in order, on every home", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const alice = await boot("a");
		const bob = await boot("b");
		const cara = await boot("c");
		link(alice.deps, "b", bob.npub, bob.deps, "a", alice.npub);
		link(alice.deps, "c", cara.npub, cara.deps, "a", alice.npub);
		link(bob.deps, "c", cara.npub, cara.deps, "b", bob.npub);

		const printed: string[] = [];
		alice.deps.write = (text) => printed.push(text);
		await phoneThreadNew("#t", ["+b", "+c"], { subject: "t" }, alice.deps);
		expect(pool.events).toEqual([]);
		const created = parseNdjson(printed)[0] as { handle: string; id: string };
		expect(created.handle).toBe("#t");

		const listeners = [listen(alice.deps, 5101), listen(bob.deps, 5102), listen(cara.deps, 5103)];
		await Promise.all(listeners.map((listener) => listener.ready));

		printed.length = 0;
		await phoneSay("#t", "from-a", alice.deps);
		const sent = parseNdjson(printed).at(-1) as { behind: string[]; members: { handle: string; relays_ok: string[] }[] };
		expect(sent.behind).toEqual([]);
		expect(sent.members.map((member) => member.handle).sort()).toEqual(["+a", "+b", "+c"]);
		expect(sent.members.every((member) => member.relays_ok.length > 0)).toBe(true);
		clock += 1;
		bob.deps.write = (text) => printed.push(text);
		await phoneSay("#t", "from-b", bob.deps);
		clock += 1;
		cara.deps.write = (text) => printed.push(text);
		await phoneSay("#t", "from-c", cara.deps);

		const threadRows = (deps: PhoneDeps) =>
			deps.db.recentMessages(10).filter((row) => row.thread_id !== null);
		for (const home of [alice, bob, cara]) {
			const stored = threadRows(home.deps);
			expect(stored.map((row) => row.text)).toEqual(["from-a", "from-b", "from-c"]);
			expect(new Set(stored.map((row) => row.id)).size).toBe(3);
		}
		const ids = threadRows(alice.deps).map((row) => row.id);
		expect(threadRows(bob.deps).map((row) => row.id)).toEqual(ids);
		expect(threadRows(cara.deps).map((row) => row.id)).toEqual(ids);
		expect(threadRows(alice.deps).map((row) => row.direction)).toEqual(["out", "in", "in"]);
		expect(threadRows(bob.deps).map((row) => row.direction)).toEqual(["in", "out", "in"]);
		expect(bob.deps.db.getThreadByHandle("#t")?.via).toBe("admit");
		expect(alice.deps.db.getThreadByHandle("#t")?.id).toBe(bob.deps.db.getThreadByHandle("#t")?.id);

		const inbox = rows(bob.deps, "#t");
		expect(inbox.map((row) => row.line)).toEqual(["[#t] +a: from-a", "[#t] +b: from-b", "[#t] +c: from-c"]);
		const mailed: string[] = [];
		const previousWrite = bob.deps.write;
		bob.deps.write = (text) => mailed.push(text);
		await phoneVoicemail(bob.deps);
		bob.deps.write = previousWrite;
		expect(parseNdjson(mailed).map((row) => (row as { line?: string }).line)).toEqual(["[#t] +a: from-a", "[#t] +c: from-c"]);
		expect(rows(bob.deps, "+a").map((row) => row.text ?? "")).not.toContain("from-a");
		expect(rows(bob.deps, "+a").some((row) => row.thread !== undefined)).toBe(false);

		for (const listener of listeners) listener.stop();
		await Promise.all(listeners.map((listener) => listener.run));
	});

	it("holds a thread when a member is a stranger and does not auto-join", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const alice = await boot("a");
		const bob = await boot("b");
		const stranger = await boot("s");
		link(alice.deps, "b", bob.npub, bob.deps, "a", alice.npub);
		addContact(alice.deps.db, {
			npub: stranger.npub,
			handle: "s",
			relays: RELAYS,
			keyId: numberKeyId(alice.deps.db),
			addedAt: clock,
			via: "accept",
		});
		await phoneThreadNew("#t", ["+b", "+s"], { subject: "secret-subject" }, alice.deps);
		const stderr: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
		const listener = listen(bob.deps, 5202);
		await listener.ready;
		const sent: string[] = [];
		alice.deps.write = (text) => sent.push(text);
		await phoneSay("#t", "secret-body", alice.deps);
		listener.stop();
		await listener.run;
		spy.mockRestore();

		expect(bob.deps.db.listThreads()).toEqual([]);
		expect(bob.deps.db.recentMessages(10).some((row) => row.text === "secret-body")).toBe(false);
		const rumorId = (parseNdjson(sent).at(-1) as { id: string }).id;
		expect(bob.deps.db.pendingByRumor(rumorId)?.text).toBe("secret-body");
		const notice = bob.deps.db.recentMessages(20).find((row) => row.sender === "phone");
		expect(notice?.text).toContain("held thread");
		expect(notice?.text).not.toContain("secret-body");
		expect(stderr.join("")).toContain("held thread");
		expect(stderr.join("")).not.toContain("secret-body");
		expect(bob.deps.db.recentMessages(20).filter((row) => row.thread_id !== null)).toEqual([]);
	});

	it("catches up on thread messages sent while the listener was down", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const alice = await boot("a");
		const bob = await boot("b");
		const cara = await boot("c");
		link(alice.deps, "b", bob.npub, bob.deps, "a", alice.npub);
		link(alice.deps, "c", cara.npub, cara.deps, "a", alice.npub);
		link(bob.deps, "c", cara.npub, cara.deps, "b", bob.npub);
		await phoneThreadNew("#t", ["+b", "+c"], { subject: "t" }, alice.deps);
		await phoneSay("#t", "one", alice.deps);
		clock += 1;
		await phoneSay("#t", "two", alice.deps);

		const first = listen(bob.deps, 5302);
		await first.ready;
		const caught = bob.deps.db.recentMessages(10).filter((row) => row.thread_id !== null);
		expect(caught.map((row) => row.text)).toEqual(["one", "two"]);
		first.stop();
		await first.run;

		clock += 1;
		await phoneSay("#t", "three", alice.deps);
		const second = listen(bob.deps, 5303);
		await second.ready;
		expect(bob.deps.db.recentMessages(10).filter((row) => row.thread_id !== null).map((row) => row.text)).toEqual([
			"one",
			"two",
			"three",
		]);
		expect(new Set(bob.deps.db.recentMessages(10).filter((row) => row.thread_id !== null).map((row) => row.id)).size).toBe(3);
		second.stop();
		await second.run;
	});

	it("keeps one-to-one say, inbox, rename, and accept guards unchanged", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice.deps, "b", bob.npub, bob.deps, "a", alice.npub);
		const before = pool.events.length;
		await phoneSay("+b", "plain", alice.deps);
		const added = pool.events.slice(before);
		expect(new Set(added.map((event) => event.id)).size).toBe(1);
		const rumor = nip59.unwrapEvent(added[0] as Parameters<typeof nip59.unwrapEvent>[0], readFileKey(bob.deps.db, numberKeyId(bob.deps.db)) as Uint8Array);
		expect(rumor.tags.filter((tag) => tag[0] === "p")).toHaveLength(1);
		expect(rumor.tags.some((tag) => tag[0] === "subject")).toBe(false);
		const stored = alice.deps.db.recentMessages(5);
		expect(stored.map((row) => [row.text, row.thread_id])).toEqual([["plain", null]]);
		expect(rows(alice.deps, "+b").map((row) => row.text)).toEqual(["plain"]);
		expect(rows(alice.deps, "+b")[0]?.line).toBeUndefined();

		expect(() => phoneContactsRename("+b", "#nope", alice.deps)).toThrow('a contact handle cannot start with "#", got "#nope"');
		const refused = createFakePool([]);
		const refusedDeps = phoneDeps(homeDir());
		await phoneNumber({ as: "a", relay: RELAYS }, refusedDeps);
		addContact(refusedDeps.db, {
			npub: bob.npub,
			handle: "b",
			relays: RELAYS,
			keyId: numberKeyId(refusedDeps.db),
			addedAt: clock,
			via: "accept",
		});
		refusedDeps.createPool = () => ({ ...refused, close() {} });
		await phoneThreadNew("#room", ["+b"], { subject: "room" }, refusedDeps);
		const refusedOut: string[] = [];
		refusedDeps.write = (text) => refusedOut.push(text);
		let refusedError: unknown;
		try {
			await phoneSay("#room", "nope", refusedDeps);
		} catch (err) {
			refusedError = err;
		}
		expect(refusedError).toBeInstanceOf(DgCliError);
		expect((refusedError as DgCliError).exitCode).toBe(1);
		expect((refusedError as DgCliError).message).toBe("members behind: +b");
		expect(refusedOut).toEqual([]);
		expect(refusedDeps.db.recentMessages(5).some((row) => row.text === "nope")).toBe(false);
		await expect(phoneThreadNew("t", ["+b"], {}, alice.deps)).rejects.toThrow('a thread handle must start with #, got "t"');
		await expect(phoneThreadNew("#t", ["+missing"], {}, alice.deps)).rejects.toThrow("no contact +missing");
		await phoneThreadNew("#t", ["+b"], { subject: "t" }, alice.deps);
		phoneThreadList(alice.deps);
		phoneThreadShow("#t", alice.deps);
		const mailed: string[] = [];
		alice.deps.write = (text) => mailed.push(text);
		phoneVoicemail(alice.deps);
		expect(mailed.join("")).not.toContain("plain");
	});
});

describe("accept refuses a # name", () => {
	it("rejects --name that starts with #", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const home = await boot("a");
		const card = encodeCard({
			npub: home.npub,
			relays: RELAYS,
			secret: "ab".repeat(32),
			exp: NO_EXPIRY,
			handle: "a",
		});
		await expect(phoneAccept(card, "hi", home.deps, { name: "#ops" })).rejects.toThrow(
			'a contact handle cannot start with "#", got "#ops"',
		);
		expect(home.deps.db.listContacts()).toEqual([]);
	});
});

describe("thread hold limits and partial sends", () => {
	it("drops a stranger thread and leaves no row and no notice", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const bob = await boot("b");
		const bobSk = readFileKey(bob.deps.db, numberKeyId(bob.deps.db));
		if (!bobSk) throw new Error("missing key");
		const bobPub = getPublicKey(bobSk);
		const strangerSk = generateSecretKey();
		const strangerPub = getPublicKey(strangerSk);
		const rumor = nip59.createRumor(
			{ kind: 14, content: "stranger-body", created_at: clock, tags: [["p", bobPub], ["subject", "x"]] },
			strangerSk,
		);
		pool.events.push(nip59.createWrap(nip59.createSeal(rumor, strangerSk, bobPub), bobPub));
		const stderr: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
		const listener = listen(bob.deps, 5402);
		await listener.ready;
		listener.stop();
		await listener.run;
		spy.mockRestore();

		expect(bob.deps.db.listPending()).toEqual([]);
		expect(bob.deps.db.recentMessages(10).some((row) => row.sender === "phone")).toBe(false);
		expect(bob.deps.db.listThreads()).toEqual([]);
		const log = stderr.join("");
		expect(log).toContain(strangerPub.slice(0, 8));
		expect(log).not.toContain("stranger-body");
	});

	it("saves one row when one member confirms and another does not", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool(["wss://ok.example"]);
		const alice = await boot("a");
		const bob = await boot("b");
		const cara = await boot("c");
		writeRelays(alice.deps.db, ["wss://self.example"]);
		addContact(alice.deps.db, {
			npub: bob.npub,
			handle: "b",
			relays: ["wss://ok.example"],
			keyId: numberKeyId(alice.deps.db),
			addedAt: clock,
			via: "accept",
		});
		addContact(alice.deps.db, {
			npub: cara.npub,
			handle: "c",
			relays: ["wss://no.example"],
			keyId: numberKeyId(alice.deps.db),
			addedAt: clock,
			via: "accept",
		});
		await phoneThreadNew("#t", ["+b", "+c"], { subject: "t" }, alice.deps);
		const printed: string[] = [];
		alice.deps.write = (text) => printed.push(text);
		let thrown: unknown;
		try {
			await phoneSay("#t", "partial-body", alice.deps);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(DgCliError);
		expect((thrown as DgCliError).exitCode).toBe(1);
		const sent = parseNdjson(printed).at(-1) as { behind: string[]; self_ok: boolean; id: string };
		expect(sent.behind).toEqual(["+c"]);
		expect(sent.self_ok).toBe(false);
		const stored = alice.deps.db.recentMessages(5).filter((row) => row.thread_id !== null);
		expect(stored.map((row) => row.text)).toEqual(["partial-body"]);
		const bobSk = readFileKey(bob.deps.db, numberKeyId(bob.deps.db));
		const bobPub = getPublicKey(bobSk as Uint8Array);
		const wrap = pool.events.find((event) => event.tags.some((tag) => tag[0] === "p" && tag[1] === bobPub));
		const rumor = nip59.unwrapEvent(wrap as Parameters<typeof nip59.unwrapEvent>[0], bobSk as Uint8Array);
		expect(rumor.created_at).toBe(stored[0]?.ts);
		expect(sent.id).toBe(rumor.id);
	});

	it("keeps only the newest five held rows from one sender", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice.deps, "b", bob.npub, bob.deps, "a", alice.npub);
		const aliceSk = readFileKey(alice.deps.db, numberKeyId(alice.deps.db));
		const bobSk = readFileKey(bob.deps.db, numberKeyId(bob.deps.db));
		if (!aliceSk || !bobSk) throw new Error("missing key");
		const bobPub = getPublicKey(bobSk);
		for (let index = 0; index < 6; index += 1) {
			clock += 1;
			const extra = getPublicKey(generateSecretKey());
			const rumor = nip59.createRumor(
				{
					kind: 14,
					content: `held-body-${index}`,
					created_at: clock,
					tags: [["p", bobPub], ["p", extra], ["subject", `s${index}`]],
				},
				aliceSk,
			);
			pool.events.push(nip59.createWrap(nip59.createSeal(rumor, aliceSk, bobPub), bobPub));
			const listener = listen(bob.deps, 5502 + index);
			await listener.ready;
			listener.stop();
			await listener.run;
		}
		const pending = bob.deps.db.listPending();
		expect(pending).toHaveLength(5);
		expect(pending.some((row) => row.text === "held-body-0")).toBe(false);
		const notice = bob.deps.db.recentMessages(20).find((row) => row.sender === "phone");
		expect(notice?.text).toBe("5 held threads");
		expect(notice?.text).not.toContain("held-body");
		const keptId = pending[0]?.rumor_id ?? "";
		const raw = new Database(PhoneDb.path(bob.deps.paths));
		raw.query("UPDATE pending_threads SET received_at = $received").run({ received: clock - MESSAGE_TTL_SECONDS - 10 });
		raw.close();
		pool.events.length = 0;
		const extra = getPublicKey(generateSecretKey());
		const again = nip59.createRumor(
			{ kind: 14, content: "after-expiry", created_at: clock, tags: [["p", bobPub], ["p", extra], ["subject", "later"]] },
			aliceSk,
		);
		pool.events.push(nip59.createWrap(nip59.createSeal(again, aliceSk, bobPub), bobPub));
		const later = listen(bob.deps, 5590);
		await later.ready;
		later.stop();
		await later.run;
		expect(bob.deps.db.pendingByRumor(keptId)).toBeUndefined();
		expect(bob.deps.db.listPending().map((row) => row.text)).toEqual(["after-expiry"]);
	});

	it("refuses a thread with more than 16 members", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const alice = await boot("a");
		const handles: string[] = [];
		for (let index = 0; index < 16; index += 1) {
			const handle = `m${index}`;
			handles.push(`+${handle}`);
			addContact(alice.deps.db, {
				npub: `npub1member${index}`,
				handle,
				relays: RELAYS,
				keyId: numberKeyId(alice.deps.db),
				addedAt: clock,
				via: "accept",
			});
		}
		await expect(phoneThreadNew("#big", handles, {}, alice.deps)).rejects.toThrow("a thread can have at most 16 members");
		expect(alice.deps.db.listThreads()).toEqual([]);
	});

	function heldRumor(sender: Uint8Array, bobPub: string, createdAt: number, subject: string) {
		const extra = getPublicKey(generateSecretKey());
		const rumor = nip59.createRumor(
			{ kind: 14, content: `body-${subject}`, created_at: createdAt, tags: [["p", bobPub], ["p", extra], ["subject", subject]] },
			sender,
		);
		return { rumor, event: nip59.createWrap(nip59.createSeal(rumor, sender, bobPub), bobPub) };
	}

	it("keeps a real held thread when future-dated holds fill the cap, then expires them by receive time", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const bob = await boot("b");
		const bobSk = readFileKey(bob.deps.db, numberKeyId(bob.deps.db));
		if (!bobSk) throw new Error("missing key");
		const bobPub = getPublicKey(bobSk);
		const ahead = clock + 10 * 365 * 24 * 60 * 60;
		const futureIds: string[] = [];
		for (let sender = 0; sender < 10; sender += 1) {
			const sk = generateSecretKey();
			const pub = getPublicKey(sk);
			addContact(bob.deps.db, {
				npub: nip19.npubEncode(pub),
				handle: `s${sender}`,
				relays: RELAYS,
				keyId: numberKeyId(bob.deps.db),
				addedAt: clock,
				via: "accept",
			});
			for (let copy = 0; copy < 5; copy += 1) {
				const sent = heldRumor(sk, bobPub, ahead, `f${sender}-${copy}`);
				futureIds.push(sent.rumor.id);
				pool.events.push(sent.event);
			}
		}
		let listener = listen(bob.deps, 5602);
		await listener.ready;
		listener.stop();
		await listener.run;
		expect(bob.deps.db.listPending()).toHaveLength(50);
		expect(bob.deps.db.listPending().every((row) => row.ts === row.received_at && row.ts < ahead)).toBe(true);

		clock += 1;
		const aliceSk = generateSecretKey();
		const alicePub = getPublicKey(aliceSk);
		addContact(bob.deps.db, {
			npub: nip19.npubEncode(alicePub),
			handle: "alice",
			relays: RELAYS,
			keyId: numberKeyId(bob.deps.db),
			addedAt: clock,
			via: "accept",
		});
		const real = heldRumor(aliceSk, bobPub, clock, "real");
		pool.events.push(real.event);
		listener = listen(bob.deps, 5603);
		await listener.ready;
		listener.stop();
		await listener.run;
		expect(bob.deps.db.pendingByRumor(real.rumor.id)?.text).toBe("body-real");
		expect(bob.deps.db.listPending().length).toBeLessThanOrEqual(50);

		clock += 8 * 24 * 60 * 60;
		bob.deps.db.pruneMessages();
		for (const id of futureIds) expect(bob.deps.db.pendingByRumor(id)).toBeUndefined();
		expect(bob.deps.db.pendingByRumor(real.rumor.id)).toBeUndefined();
		expect(bob.deps.db.heldNotice()).toBeUndefined();
	});

	it("does not rewrite the held notice for a duplicate, and writes none when the new row is evicted", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const bob = await boot("b");
		const aliceSk = generateSecretKey();
		const alicePub = getPublicKey(aliceSk);
		const aliceNpub = nip19.npubEncode(alicePub);
		addContact(bob.deps.db, {
			npub: aliceNpub,
			handle: "alice",
			relays: RELAYS,
			keyId: numberKeyId(bob.deps.db),
			addedAt: clock,
			via: "accept",
		});
		const bobSk = readFileKey(bob.deps.db, numberKeyId(bob.deps.db));
		if (!bobSk) throw new Error("missing key");
		const sent = heldRumor(aliceSk, getPublicKey(bobSk), clock, "once");
		pool.events.push(sent.event);
		let listener = listen(bob.deps, 5702);
		await listener.ready;
		listener.stop();
		await listener.run;
		const notice = bob.deps.db.heldNotice();
		expect(notice?.text).toBe("1 held thread");
		clock += 5;
		listener = listen(bob.deps, 5703);
		await listener.ready;
		listener.stop();
		await listener.run;
		expect(bob.deps.db.heldNotice()).toEqual(notice);
		expect(bob.deps.db.listPending()).toHaveLength(1);

		const newerThan = clock + 100;
		for (let index = 0; index < 5; index += 1) {
			clock = newerThan + index;
			bob.deps.db.insertPending({
				rumor_id: `newer-${index}`,
				room_id: `newer-${index}`,
				sender: aliceNpub,
				members: "[]",
				subject: null,
				text: "seed",
				ts: clock,
			});
		}
		bob.deps.db.deletePending([sent.rumor.id]);
		clock = newerThan - 200;
		const evicted = heldRumor(aliceSk, getPublicKey(bobSk), clock, "old");
		pool.events.push(evicted.event);
		const before = bob.deps.db.heldNotice()?.text;
		listener = listen(bob.deps, 5704);
		await listener.ready;
		listener.stop();
		await listener.run;
		expect(bob.deps.db.pendingByRumor(evicted.rumor.id)).toBeUndefined();
		expect(before).toBe("1 held thread");
		expect(bob.deps.db.heldNotice()?.text).toBe("5 held threads");
	});

	it("holds a thread in the listener when a member disappears before the row is stored", async () => {
		clock = Math.floor(Date.now() / 1000);
		pool = createFakePool();
		const bob = await boot("b");
		const aliceSk = generateSecretKey();
		const caraSk = generateSecretKey();
		const alicePub = getPublicKey(aliceSk);
		const caraPub = getPublicKey(caraSk);
		const bobSk = readFileKey(bob.deps.db, numberKeyId(bob.deps.db));
		if (!bobSk) throw new Error("missing key");
		const bobPub = getPublicKey(bobSk);
		addContact(bob.deps.db, {
			npub: nip19.npubEncode(alicePub),
			handle: "alice",
			relays: RELAYS,
			keyId: numberKeyId(bob.deps.db),
			addedAt: clock,
			via: "accept",
		});
		addContact(bob.deps.db, {
			npub: nip19.npubEncode(caraPub),
			handle: "cara",
			relays: RELAYS,
			keyId: numberKeyId(bob.deps.db),
			addedAt: clock,
			via: "accept",
		});
		const rumor = nip59.createRumor(
			{
				kind: 14,
				content: "together",
				created_at: clock,
				tags: [["p", bobPub], ["p", caraPub], ["subject", "ops"]],
			},
			aliceSk,
		);
		pool.events.push(nip59.createWrap(nip59.createSeal(rumor, aliceSk, bobPub), bobPub));
		const original = bob.deps.db.listContacts.bind(bob.deps.db);
		let calls = 0;
		bob.deps.db.listContacts = () => {
			calls += 1;
			const rows = original();
			if (calls <= 2) return rows;
			return rows.filter((row) => row.npub !== nip19.npubEncode(caraPub));
		};
		const listener = listen(bob.deps, 5802);
		await listener.ready;
		listener.stop();
		await listener.run;
		expect(bob.deps.db.listThreads()).toEqual([]);
		expect(bob.deps.db.pendingByRumor(rumor.id)?.text).toBe("together");
		expect(bob.deps.db.recentMessages(10).some((row) => row.thread_id !== null)).toBe(false);
	});
});
