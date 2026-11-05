import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19, nip59, type NostrEvent } from "nostr-tools";
import { ACK_TAG, BUSY_TAG, EPHEMERAL_GIFT_WRAP_KIND, npubOf, PRESENCE_KIND, RECEIPT_KIND } from "../../src/phone/chat";
import { phoneContacts, phoneInbox, phoneNumber, phonePing, phonePresence, phoneSay, phoneStatus, phoneThreadNew, type PhoneDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { readFileKey, type KeyClient } from "../../src/phone/keys";
import { runListener } from "../../src/phone/listener";
import { beatRelays, PING_ANSWER_CAP, PRESENCE_FANOUT } from "../../src/phone/presence";
import { addContact, numberKeyId } from "../../src/phone/store";
import { createFakePool, type FakePool, makeHomeTracker, parseNdjson } from "./fake-pool";
import { fakeWormhole } from "./fake-wormhole";

const RELAYS = ["wss://a.example"];
const PRESENCE_TEST = { minMs: 1000, maxMs: 2000, random: () => 0.5 };
const PRESENCE_DELAY_MS = 1500;
const tracker = makeHomeTracker("dg-phone-presence-");
let clock: number;
let pool: FakePool;

type Phone = { deps: PhoneDeps; npub: string; pub: string; sk: Uint8Array; out: string[] };
type Timer = { delayMs: number; run: () => void };

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await Bun.sleep(5);
	}
}

async function boot(name: string): Promise<Phone> {
	const paths = resolveDgPaths({ env: { DG_HOME: tracker.freshHome() } });
	const db = PhoneDb.open(paths, () => clock);
	tracker.trackDb(db);
	const out: string[] = [];
	const deps: PhoneDeps = {
		paths,
		db,
		createPool: () => ({ ...pool, close() {} }),
		write: (text) => out.push(text),
		readStdin: async () => undefined,
		now: () => clock,
		sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
	};
	await phoneNumber({ as: name, relay: RELAYS }, deps);
	const sk = readFileKey(db, numberKeyId(db));
	if (!sk) throw new Error("missing number key");
	out.length = 0;
	return { deps, npub: npubOf(sk), pub: getPublicKey(sk), sk, out };
}

function link(left: Phone, leftHandle: string, right: Phone, rightHandle: string): void {
	addContact(left.deps.db, { npub: right.npub, handle: leftHandle, relays: RELAYS, keyId: numberKeyId(left.deps.db), addedAt: clock, via: "accept" });
	addContact(right.deps.db, { npub: left.npub, handle: rightHandle, relays: RELAYS, keyId: numberKeyId(right.deps.db), addedAt: clock, via: "accept" });
}

function capturingSchedule(): { schedule: Schedule; timers: Timer[] } {
	const timers: Timer[] = [];
	const schedule: Schedule = (delayMs, run) => {
		const timer = { delayMs, run };
		timers.push(timer);
		return () => {
			const at = timers.indexOf(timer);
			if (at >= 0) timers.splice(at, 1);
		};
	};
	return { schedule, timers };
}

function listen(phone: Phone, opts: { schedule?: Schedule; pid?: number; wormhole?: boolean } = {}) {
	let stop: () => void = () => {};
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const run = runListener({
		paths: phone.deps.paths,
		db: phone.deps.db,
		sessionClient: phone.deps.sessionClient,
		grantClient: phone.deps.grantClient,
		createPool: () => ({ ...pool, close() {} }),
		now: () => clock,
		pid: opts.pid ?? 7000 + Math.floor(Math.random() * 1000),
		schedule: opts.schedule ?? ((() => () => {}) as Schedule),
		onSignal: (signal, handler) => {
			if (signal !== "SIGTERM") return;
			stop = handler;
			ready();
		},
		presence: PRESENCE_TEST,
		...(opts.wormhole ? { wormhole: fakeWormhole(tracker.freshHome(), { rendezvous: tracker.freshHome() }).deps } : {}),
	});
	return {
		started,
		stop: async () => {
			stop();
			await run;
		},
	};
}

function opened(to: Phone, kind: number): { event: NostrEvent; rumor: ReturnType<typeof nip59.unwrapEvent> }[] {
	const found: { event: NostrEvent; rumor: ReturnType<typeof nip59.unwrapEvent> }[] = [];
	for (const event of pool.events) {
		if (!event.tags.some((tag) => tag[0] === "p" && tag[1] === to.pub)) continue;
		try {
			const rumor = nip59.unwrapEvent(event.kind === EPHEMERAL_GIFT_WRAP_KIND ? { ...event, kind: 1059 } : event, to.sk);
			if (rumor.kind === kind) found.push({ event, rumor });
		} catch {}
	}
	return found;
}

function control(from: Uint8Array, to: string, kind: number, tags: string[][], createdAt = Math.floor(Date.now() / 1000)) {
	return nip59.createRumor({ kind, content: "", tags: [["p", to], ...tags], created_at: createdAt }, from);
}

function wrapRumor(rumor: ReturnType<typeof nip59.createRumor>, from: Uint8Array, to: string): NostrEvent {
	return nip59.createWrap(nip59.createSeal(rumor, from, to), to);
}

async function deliver(event: NostrEvent): Promise<void> {
	await Promise.all(pool.publish(RELAYS, event));
}

function deliveredAt(phone: Phone, id: string): number | null | undefined {
	return phone.deps.db.recentMessages(100).find((row) => row.id === id)?.delivered_at;
}

function printed(phone: Phone): Record<string, unknown>[] {
	const rows = parseNdjson(phone.out) as Record<string, unknown>[];
	phone.out.length = 0;
	return rows;
}

beforeEach(() => {
	clock = Math.floor(Date.now() / 1000);
	pool = createFakePool();
});

afterEach(() => {
	tracker.cleanup();
	process.exitCode = 0;
});

describe("delivery receipts", () => {
	let alice: Phone;
	let bob: Phone;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
	});

	it("marks a direct message delivered once the recipient's listener stores it, and inbox shows it", async () => {
		const aliceListener = listen(alice);
		const bobListener = listen(bob);
		await Promise.all([aliceListener.started, bobListener.started]);
		try {
			await phoneSay("+b", "hi", alice.deps);
			const said = printed(alice)[0] as { id: string; delivered: boolean };
			expect(said.delivered).toBe(false);

			await waitUntil(() => typeof deliveredAt(alice, said.id) === "number");
			const receipts = opened(alice, RECEIPT_KIND);
			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.rumor.pubkey).toBe(bob.pub);
			expect(receipts[0]?.rumor.tags).toContainEqual(["e", said.id]);

			phoneInbox({ handle: "+b" }, alice.deps);
			expect(printed(alice)).toEqual([expect.objectContaining({ id: said.id, direction: "out", delivered: true })]);
			phoneInbox({ handle: "+a" }, bob.deps);
			expect(printed(bob)[0]).not.toHaveProperty("delivered");
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}
		expect(opened(bob, RECEIPT_KIND)).toEqual([]);
	});

	it("marks a thread message delivered by the rumor id every member stores", async () => {
		const aliceListener = listen(alice);
		const bobListener = listen(bob);
		await Promise.all([aliceListener.started, bobListener.started]);
		try {
			await phoneThreadNew("#ops", ["+b"], { subject: "ops" }, alice.deps);
			await phoneSay("#ops", "standup", alice.deps);
			const said = printed(alice).at(-1) as { id: string; delivered: boolean };
			expect(said.delivered).toBe(false);

			await waitUntil(() => typeof deliveredAt(alice, said.id) === "number");
			expect(opened(alice, RECEIPT_KIND)[0]?.rumor.tags).toContainEqual(["e", said.id]);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}
	});

	it("ignores a receipt from a contact who was not the recipient, and from a stranger", async () => {
		const carol = await boot("c");
		link(alice, "c", carol, "a");
		await phoneSay("+b", "hi", alice.deps);
		const said = printed(alice)[0] as { id: string };
		const aliceListener = listen(alice);
		await aliceListener.started;
		try {
			const stranger = generateSecretKey();
			await deliver(wrapRumor(control(carol.sk, alice.pub, RECEIPT_KIND, [["e", said.id]]), carol.sk, alice.pub));
			await deliver(wrapRumor(control(stranger, alice.pub, RECEIPT_KIND, [["e", said.id]]), stranger, alice.pub));
			await Bun.sleep(20);
			expect(deliveredAt(alice, said.id)).toBeNull();

			await deliver(wrapRumor(control(bob.sk, alice.pub, RECEIPT_KIND, [["e", said.id]]), bob.sk, alice.pub));
			await waitUntil(() => typeof deliveredAt(alice, said.id) === "number");
		} finally {
			await aliceListener.stop();
		}
		expect(opened(carol, RECEIPT_KIND)).toEqual([]);
		expect(opened(bob, RECEIPT_KIND)).toEqual([]);
	});

	it("ignores a receipt dated more than five minutes from the local clock", async () => {
		await phoneSay("+b", "hi", alice.deps);
		const said = printed(alice)[0] as { id: string };
		const aliceListener = listen(alice);
		await aliceListener.started;
		try {
			await deliver(wrapRumor(control(bob.sk, alice.pub, RECEIPT_KIND, [["e", said.id]], clock - 301), bob.sk, alice.pub));
			await deliver(wrapRumor(control(bob.sk, alice.pub, RECEIPT_KIND, [["e", said.id]], clock + 301), bob.sk, alice.pub));
			await Bun.sleep(20);
			expect(deliveredAt(alice, said.id)).toBeNull();

			await deliver(wrapRumor(control(bob.sk, alice.pub, RECEIPT_KIND, [["e", said.id]], clock + 299), bob.sk, alice.pub));
			await waitUntil(() => typeof deliveredAt(alice, said.id) === "number");
		} finally {
			await aliceListener.stop();
		}
	});

	it("answers a check once per rumor, only for a contact, and never answers a receipt or a beat", async () => {
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			const check = control(alice.sk, bob.pub, PRESENCE_KIND, [[ACK_TAG, "1"]]);
			const first = wrapRumor(check, alice.sk, bob.pub);
			await deliver(first);
			await deliver(wrapRumor(check, alice.sk, bob.pub));
			const stranger = generateSecretKey();
			await deliver(wrapRumor(control(stranger, bob.pub, PRESENCE_KIND, [[ACK_TAG, "1"]]), stranger, bob.pub));
			await deliver(wrapRumor(control(alice.sk, bob.pub, PRESENCE_KIND, []), alice.sk, bob.pub));
			await deliver(wrapRumor(control(alice.sk, bob.pub, RECEIPT_KIND, [["e", "f".repeat(64)]]), alice.sk, bob.pub));
			await waitUntil(() => opened(alice, RECEIPT_KIND).length === 1);
			await Bun.sleep(20);

			const receipts = opened(alice, RECEIPT_KIND);
			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.rumor.tags).toContainEqual(["e", first.id]);
			expect(pool.events.filter((event) => event.tags.some((tag) => tag[0] === "p" && tag[1] === getPublicKey(stranger)))).toEqual([]);
		} finally {
			await bobListener.stop();
		}
	});
});

describe("presence", () => {
	it("beats to every contact at start and again on a jittered timer, and records last seen", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		const { schedule, timers } = capturingSchedule();
		const bobListener = listen(bob);
		await bobListener.started;
		const aliceListener = listen(alice, { schedule });
		await aliceListener.started;
		try {
			await waitUntil(() => opened(bob, PRESENCE_KIND).length === 1);
			await waitUntil(() => bob.deps.db.getContactByNpub(alice.npub)?.last_seen !== null);
			expect(opened(bob, PRESENCE_KIND).map((entry) => entry.event.kind)).toEqual([EPHEMERAL_GIFT_WRAP_KIND]);
			expect(opened(alice, RECEIPT_KIND)).toEqual([]);

			const beat = timers.find((timer) => timer.delayMs === PRESENCE_DELAY_MS);
			expect(beat).toBeDefined();
			await Bun.sleep(50);
			beat?.run();
			await waitUntil(() => opened(bob, PRESENCE_KIND).length === 2);

			phoneContacts(bob.deps);
			const listed = printed(bob)[0] as { handle: string; last_seen: string | null };
			expect(listed.handle).toBe("+a");
			expect(listed.last_seen).toBe(new Date((bob.deps.db.getContactByNpub(alice.npub)?.last_seen ?? 0) * 1000).toISOString());
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}
	});

	it("shows null last seen for a contact never heard from", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		phoneContacts(alice.deps);
		expect(printed(alice)[0]).toMatchObject({ handle: "+b", last_seen: null });
	});

	it("caps one beat at the fan-out limit and starts the next beat where it stopped", async () => {
		const alice = await boot("a");
		const peers = Array.from({ length: PRESENCE_FANOUT + 1 }, (_, index) => {
			const sk = generateSecretKey();
			addContact(alice.deps.db, {
				npub: nip19.npubEncode(getPublicKey(sk)),
				handle: `p${index}`,
				relays: RELAYS,
				keyId: numberKeyId(alice.deps.db),
				addedAt: clock,
				via: "accept",
			});
			return getPublicKey(sk);
		});
		const beatsTo = () => pool.events.filter((event) => peers.includes(event.tags.find((tag) => tag[0] === "p")?.[1] ?? "")).length;
		const { schedule, timers } = capturingSchedule();
		const aliceListener = listen(alice, { schedule });
		await aliceListener.started;
		try {
			await waitUntil(() => beatsTo() === PRESENCE_FANOUT);
			await Bun.sleep(50);
			expect(beatsTo()).toBe(PRESENCE_FANOUT);

			timers.find((timer) => timer.delayMs === PRESENCE_DELAY_MS)?.run();
			await waitUntil(() => beatsTo() === PRESENCE_FANOUT * 2);
			const counts = new Map<string, number>();
			for (const event of pool.events) {
				const to = event.tags.find((tag) => tag[0] === "p")?.[1] ?? "";
				counts.set(to, (counts.get(to) ?? 0) + 1);
			}
			expect(peers.every((pub) => (counts.get(pub) ?? 0) >= 1)).toBe(true);
		} finally {
			await aliceListener.stop();
		}
	});

	it("retries a deferred image fetch when its sender comes online", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		bob.deps.db.addMessage({ id: "img", ts: clock, sender: alice.npub, contact: alice.npub, text: "[image pending]", direction: "in", call: 0 });
		bob.deps.db.addImageFetch({
			message_id: "img",
			sender: alice.pub,
			key_id: numberKeyId(bob.deps.db),
			x: "a".repeat(64),
			ox: "b".repeat(64),
			size: 100,
			key: "c".repeat(64),
			nonce: "d".repeat(24),
			next_at: clock + 3600,
			deadline: clock + 7200,
		});
		const bobListener = listen(bob, { wormhole: true });
		await bobListener.started;
		try {
			await Bun.sleep(20);
			expect(bob.deps.db.imageFetches()[0]?.attempts).toBe(0);

			await deliver(wrapRumor(control(alice.sk, bob.pub, PRESENCE_KIND, []), alice.sk, bob.pub));
			await waitUntil(() => bob.deps.db.imageFetches()[0]?.next_at !== clock + 3600);
		} finally {
			await bobListener.stop();
		}
	});
});

describe("phone ping", () => {
	let alice: Phone;
	let bob: Phone;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
	});

	function countingSubscribes(phone: Phone): () => number {
		let count = 0;
		phone.deps.createPool = () => ({
			...pool,
			subscribe: (...args: Parameters<FakePool["subscribe"]>) => {
				count += 1;
				return pool.subscribe(...args);
			},
			close() {},
		});
		return () => count;
	}

	it("reads the receipt from the database when the local listener runs", async () => {
		const aliceListener = listen(alice, { pid: process.pid });
		const bobListener = listen(bob);
		await Promise.all([aliceListener.started, bobListener.started]);
		const subscribes = countingSubscribes(alice);
		try {
			await phonePing("+b", {}, alice.deps);
			expect(printed(alice)).toEqual([{ handle: "+b", delivered: true, after_s: 0, line: "delivered after 0 s" }]);
			expect(subscribes()).toBe(0);
			expect(process.exitCode ?? 0).toBe(0);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}
	});

	it("opens a short subscription when no local listener runs", async () => {
		const bobListener = listen(bob);
		await bobListener.started;
		const subscribes = countingSubscribes(alice);
		try {
			await phonePing("+b", { timeout: "5" }, alice.deps);
			expect(printed(alice)).toEqual([{ handle: "+b", delivered: true, after_s: 0, line: "delivered after 0 s" }]);
			expect(subscribes()).toBe(1);
			expect(pool.listeners).toHaveLength(1);
		} finally {
			await bobListener.stop();
		}
	});

	it("answers two pings sent in the same second, since each check carries its own nonce", async () => {
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			await phonePing("+b", { timeout: "5" }, alice.deps);
			await phonePing("+b", { timeout: "5" }, alice.deps);

			expect(printed(alice).map((row) => row.line)).toEqual(["delivered after 0 s", "delivered after 0 s"]);
		} finally {
			await bobListener.stop();
		}
	});

	it("pings a thread and counts the first member's receipt", async () => {
		await phoneThreadNew("#ops", ["+b"], {}, alice.deps);
		printed(alice);
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			await phonePing("#ops", {}, alice.deps);
			expect(printed(alice)).toEqual([{ handle: "#ops", delivered: true, after_s: 0, line: "delivered after 0 s" }]);
		} finally {
			await bobListener.stop();
		}
	});

	it("prints no answer and exits 1 when no receipt comes before the timeout", async () => {
		await phonePing("+b", { timeout: "1" }, alice.deps);

		expect(printed(alice)).toEqual([{ handle: "+b", delivered: false, after_s: 1, line: "no answer after 1 s" }]);
		expect(process.exitCode).toBe(1);
		expect(opened(bob, PRESENCE_KIND).map((entry) => entry.rumor.tags)).toEqual([[["p", bob.pub], [ACK_TAG, "1"], ["n", expect.stringMatching(/^[0-9a-f]{32}$/)]]]);
		expect(opened(bob, PRESENCE_KIND).map((entry) => entry.event.kind)).toEqual([1059]);
	});

	it("rejects a bad timeout and an unknown handle", async () => {
		await expect(phonePing("+b", { timeout: "0" }, alice.deps)).rejects.toThrow("--timeout must be");
		await expect(phonePing("+b", { timeout: "abc" }, alice.deps)).rejects.toThrow("--timeout must be");
		await expect(phonePing("+nobody", {}, alice.deps)).rejects.toThrow("no contact +nobody");
		await expect(phonePing("#none", {}, alice.deps)).rejects.toThrow("no group #none");
	});
});

describe("phone presence off", () => {
	it("defaults to on, saves off, and shows it in status", async () => {
		const alice = await boot("a");
		phonePresence(undefined, alice.deps);
		phonePresence("off", alice.deps);
		await phoneStatus(alice.deps);
		const [shown, saved, status] = printed(alice);

		expect(shown).toEqual({ presence: "on" });
		expect(saved).toEqual({ presence: "off" });
		expect(status).toMatchObject({ presence: "off" });
		expect(() => phonePresence("maybe", alice.deps)).toThrow('presence takes on or off, got "maybe"');
	});

	it("sends no beat, no receipt, and no ping answer, but still records last seen", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		phonePresence("off", bob.deps);
		const { schedule, timers } = capturingSchedule();
		const bobListener = listen(bob, { schedule });
		await bobListener.started;
		try {
			await phoneSay("+a", "hi", bob.deps);
			await phoneSay("+b", "hello", alice.deps);
			await deliver(wrapRumor(control(alice.sk, bob.pub, PRESENCE_KIND, [[ACK_TAG, "1"]]), alice.sk, bob.pub));
			timers.find((timer) => timer.delayMs === PRESENCE_DELAY_MS)?.run();
			await waitUntil(() => bob.deps.db.recentMessages(10).some((row) => row.text === "hello"));
			await Bun.sleep(50);

			expect(opened(alice, PRESENCE_KIND)).toEqual([]);
			expect(opened(alice, RECEIPT_KIND)).toEqual([]);
			expect(bob.deps.db.getContactByNpub(alice.npub)?.last_seen).not.toBeNull();
		} finally {
			await bobListener.stop();
		}
	});
});

describe("ping answer cap", () => {
	let alice: Phone;
	let bob: Phone;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
	});

	function answered(): { plain: string[]; busy: string[] } {
		const plain: string[] = [];
		const busy: string[] = [];
		for (const { rumor } of opened(alice, RECEIPT_KIND)) {
			const ids = rumor.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1] as string);
			(rumor.tags.some((tag) => tag[0] === BUSY_TAG && tag[1] === "1") ? busy : plain).push(...ids);
		}
		return { plain, busy };
	}

	async function check(): Promise<string> {
		const event = wrapRumor(control(alice.sk, bob.pub, PRESENCE_KIND, [[ACK_TAG, "1"], ["n", randomUUID()]]), alice.sk, bob.pub);
		await deliver(event);
		return event.id;
	}

	it("answers busy past the cap per minute, stops after a second cap, and keeps message receipts uncapped", async () => {
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			const ids: string[] = [];
			for (let index = 0; index < PING_ANSWER_CAP * 2 + 5; index += 1) ids.push(await check());
			await waitUntil(() => answered().plain.length + answered().busy.length === PING_ANSWER_CAP * 2);
			await phoneSay("+b", "still here?", alice.deps);
			const said = printed(alice)[0] as { id: string };
			await waitUntil(() => answered().plain.includes(said.id));
			await Bun.sleep(30);

			const { plain, busy } = answered();
			expect(plain).toEqual([...ids.slice(0, PING_ANSWER_CAP), said.id]);
			expect(busy).toEqual(ids.slice(PING_ANSWER_CAP, PING_ANSWER_CAP * 2));
		} finally {
			await bobListener.stop();
		}
	});

	it("makes phone ping print busy and exit 1 when the answer is a busy receipt", async () => {
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			for (let index = 0; index < PING_ANSWER_CAP; index += 1) await check();
			await waitUntil(() => answered().plain.length === PING_ANSWER_CAP);

			await phonePing("+b", { timeout: "5" }, alice.deps);

			expect(printed(alice)).toEqual([{ handle: "+b", delivered: false, busy: true, after_s: 0, line: "busy, try later" }]);
			expect(process.exitCode).toBe(1);
		} finally {
			await bobListener.stop();
		}
	});
});

describe("ephemeral beats", () => {
	it("subscribes live to kind 21059 but never asks catch-up for it, and sends receipts as kind 1059", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		const queried: number[][] = [];
		const subscribed: number[][] = [];
		const query = pool.querySync;
		const sub = pool.subscribe;
		pool.querySync = (relays, filter, params) => {
			if (filter["#p"]) queried.push(filter.kinds ?? []);
			return query(relays, filter, params);
		};
		pool.subscribe = (relays, filter, params) => {
			subscribed.push(filter.kinds ?? []);
			return sub(relays, filter, params);
		};
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			await phoneSay("+b", "hi", alice.deps);
			await waitUntil(() => opened(alice, RECEIPT_KIND).length === 1);

			expect(queried.length).toBeGreaterThan(0);
			expect(queried.every((kinds) => kinds.length === 1 && kinds[0] === 1059)).toBe(true);
			expect(subscribed).toEqual([[1059, EPHEMERAL_GIFT_WRAP_KIND]]);
			expect(opened(alice, RECEIPT_KIND).map((entry) => entry.event.kind)).toEqual([1059]);
		} finally {
			await bobListener.stop();
		}
	});

	it("drops a chat message or a ping check that arrives in an ephemeral wrap", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		const bobListener = listen(bob);
		await bobListener.started;
		try {
			const cases: [number, string[][]][] = [
				[14, []],
				[PRESENCE_KIND, [[ACK_TAG, "1"]]],
			];
			for (const [kind, tags] of cases) {
				const wrap = wrapRumor(nip59.createRumor({ kind, content: "sneaky", tags: [["p", bob.pub], ...tags] }, alice.sk), alice.sk, bob.pub);
				await deliver({ ...wrap, kind: EPHEMERAL_GIFT_WRAP_KIND });
			}
			await Bun.sleep(30);

			expect(bob.deps.db.recentMessages(10).some((row) => row.text === "sneaky")).toBe(false);
			expect(opened(alice, RECEIPT_KIND)).toEqual([]);
		} finally {
			await bobListener.stop();
		}
	});
});

describe("beat relays", () => {
	it("keeps the beat allowlist, else the contact relays without nos.lol", () => {
		expect(beatRelays(["wss://nos.lol", "wss://relay.damus.io/", "wss://relay.primal.net"])).toEqual(["wss://relay.damus.io/", "wss://relay.primal.net"]);
		expect(beatRelays(["wss://nos.lol", "wss://relay.example", "wss://NOS.lol/"])).toEqual(["wss://relay.example"]);
		expect(beatRelays(["wss://nos.lol"])).toEqual([]);
	});

	it("never publishes a beat to nos.lol, while a receipt still may", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		const relays = ["wss://nos.lol", "wss://relay.damus.io"];
		addContact(alice.deps.db, { npub: bob.npub, handle: "b", relays, keyId: numberKeyId(alice.deps.db), addedAt: clock, via: "accept" });
		addContact(bob.deps.db, { npub: alice.npub, handle: "a", relays, keyId: numberKeyId(bob.deps.db), addedAt: clock, via: "accept" });
		const sent: { kind: number; relays: string[] }[] = [];
		const publish = pool.publish;
		pool.publish = (targets, event) => {
			sent.push({ kind: event.kind, relays: [...targets] });
			return publish(targets, event);
		};
		const bobListener = listen(bob);
		await bobListener.started;
		const aliceListener = listen(alice);
		await aliceListener.started;
		try {
			await phoneSay("+b", "hi", alice.deps);
			const said = printed(alice)[0] as { id: string };
			await waitUntil(() => typeof deliveredAt(alice, said.id) === "number");
			expect(sent.filter((entry) => entry.kind === 1059).every((entry) => entry.relays.includes("wss://nos.lol"))).toBe(true);

			const beats = sent.filter((entry) => entry.kind === EPHEMERAL_GIFT_WRAP_KIND);
			expect(beats.length).toBeGreaterThan(0);
			expect(beats.every((entry) => entry.relays.join() === "wss://relay.damus.io")).toBe(true);
		} finally {
			await aliceListener.stop();
			await bobListener.stop();
		}
	});
});
