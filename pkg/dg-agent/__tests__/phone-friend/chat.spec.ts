import { describe, expect, it } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import {
	fetchNew,
	LOOKBACK_SECONDS,
	publish,
	subscribe,
	unwrapFromContact,
	wrap,
} from "../../src/phone-friend/chat";
import { SEEN_ID_LIMIT } from "../../src/phone-friend/store";
import { createFakePool } from "./fake-pool";

const RELAYS = ["wss://a.example", "wss://b.example"];

function identity() {
	const sk = generateSecretKey();
	return { sk, pub: getPublicKey(sk) };
}

describe("wrap and unwrapFromContact", () => {
	it("returns the sent text, sender npub, and inner timestamp", () => {
		const alice = identity();
		const bob = identity();
		const event = wrap("hello bob", alice.sk, bob.pub);

		const message = unwrapFromContact(event, bob.sk, alice.pub);

		expect(message?.text).toBe("hello bob");
		expect(message?.from).toBe(nip19.npubEncode(alice.pub));
		expect(message?.id).toBe(event.id);
		expect(Math.abs((message?.ts ?? 0) - Date.now() / 1000)).toBeLessThan(5);
	});

	it("returns null for a message from someone other than the contact", () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const event = wrap("i am alice", mallory.sk, bob.pub);

		expect(unwrapFromContact(event, bob.sk, alice.pub)).toBeNull();
	});

	it("returns null when the wrap is not addressed to us", () => {
		const alice = identity();
		const bob = identity();
		const carol = identity();
		const event = wrap("for carol", alice.sk, carol.pub);

		expect(unwrapFromContact(event, bob.sk, alice.pub)).toBeNull();
	});

	it("returns null for an event that is not a gift wrap", () => {
		const alice = identity();
		const bob = identity();
		const note = finalizeEvent(
			{ kind: 1, created_at: 0, tags: [], content: "plain" },
			alice.sk,
		);

		expect(unwrapFromContact(note, bob.sk, alice.pub)).toBeNull();
	});
});

describe("publish", () => {
	it("returns only the relays that accepted the event", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool([RELAYS[1]]);

		const result = await publish(pool, RELAYS, wrap("hi", alice.sk, bob.pub));

		expect(result.ok).toEqual([RELAYS[1]]);
	});

	it("returns an empty list when every relay refuses", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool([]);

		const result = await publish(pool, RELAYS, wrap("hi", alice.sk, bob.pub));

		expect(result.ok).toEqual([]);
	});
});

describe("fetchNew", () => {
	it("queries gift wraps for us with a two-day lookback before the cursor", async () => {
		const bob = identity();
		const pool = createFakePool();
		const cursor = 1_800_000_000;

		await fetchNew(pool, RELAYS, bob.sk, identity().pub, { cursor, ids: [] }, () => cursor + 10);

		expect(pool.filters[0]).toEqual({
			kinds: [1059],
			"#p": [bob.pub],
			since: cursor - LOOKBACK_SECONDS,
		});
		expect(LOOKBACK_SECONDS).toBe(172800);
	});

	it("returns contact messages once, drops seen ids, and moves the cursor", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		await publish(pool, RELAYS, wrap("one", alice.sk, bob.pub));
		await publish(pool, RELAYS, wrap("two", alice.sk, bob.pub));
		const now = Math.floor(Date.now() / 1000);

		const first = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] }, () => now);
		const second = await fetchNew(pool, RELAYS, bob.sk, alice.pub, first.seen, () => now + 1);

		expect(first.messages.map((m) => m.text).sort()).toEqual(["one", "two"]);
		expect(first.seen.cursor).toBe(now);
		expect(second.messages).toEqual([]);
		expect(second.seen.cursor).toBe(now + 1);
	});

	it("still returns a wrap whose created_at is a day before the cursor", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const event = wrap("late", alice.sk, bob.pub);
		await publish(pool, RELAYS, event);
		const cursor = event.created_at + 86400;

		const { messages } = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor, ids: [] }, () => cursor);

		expect(messages.map((m) => m.text)).toEqual(["late"]);
	});

	it("drops non-contact messages and keeps their ids out of the saved seen list", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		const spam = wrap("spam", mallory.sk, bob.pub);
		await publish(pool, RELAYS, spam);

		const { messages, seen } = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] });

		expect(messages).toEqual([]);
		expect(seen.ids).not.toContain(spam.id);
	});

	it("keeps a contact id seen after a stranger floods past the id limit", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		await publish(pool, ["wss://a.example"], wrap("real", alice.sk, bob.pub));
		const first = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] });
		const junk = wrap("x", mallory.sk, bob.pub);
		for (let i = 0; i < SEEN_ID_LIMIT + 1; i += 1) {
			pool.events.push({ ...junk, id: i.toString(16).padStart(64, "0"), pubkey: "0".repeat(64) });
		}

		const second = await fetchNew(pool, RELAYS, bob.sk, alice.pub, first.seen);
		const third = await fetchNew(pool, RELAYS, bob.sk, alice.pub, second.seen);

		expect(first.messages.map((m) => m.text)).toEqual(["real"]);
		expect(second.messages).toEqual([]);
		expect(third.messages).toEqual([]);
	});

	it("sorts messages by inner timestamp", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const at = (content: string, created_at: number) =>
			nip59.createWrap(
				nip59.createSeal(
					nip59.createRumor({ kind: 14, content, created_at, tags: [["p", bob.pub]] }, alice.sk),
					alice.sk,
					bob.pub,
				),
				bob.pub,
			);
		pool.events.push(at("second", 2_000), at("first", 1_000));

		const { messages } = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] });

		expect(messages.map((m) => [m.text, m.ts])).toEqual([
			["first", 1_000],
			["second", 2_000],
		]);
	});
});

describe("subscribe", () => {
	it("delivers each new contact message once with the updated seen state", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const received: string[] = [];
		let latestIds: string[] = [];
		const sub = subscribe(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] }, (message, seen) => {
			received.push(message.text);
			latestIds = seen.ids;
		});
		const event = wrap("live", alice.sk, bob.pub);

		await publish(pool, RELAYS, event);
		sub.close();

		expect(received).toEqual(["live"]);
		expect(latestIds).toEqual([event.id]);
	});

	it("never delivers a stranger message and keeps its id out of the seen state", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		const received: string[] = [];
		let latestIds: string[] = [];
		const sub = subscribe(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] }, (message, seen) => {
			received.push(message.text);
			latestIds = seen.ids;
		});
		const real = wrap("real", alice.sk, bob.pub);

		await publish(pool, RELAYS, wrap("spam", mallory.sk, bob.pub));
		await publish(pool, RELAYS, real);
		sub.close();

		expect(received).toEqual(["real"]);
		expect(latestIds).toEqual([real.id]);
	});
});
