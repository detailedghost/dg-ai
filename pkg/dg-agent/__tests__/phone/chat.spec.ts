import { describe, expect, it } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
	fetchNew,
	LOOKBACK_SECONDS,
	publish,
	subscribe,
	unwrapFromPeer,
	wrap,
} from "../../src/phone/chat";
import { createFakePool } from "./fake-pool";

const RELAYS = ["wss://a.example", "wss://b.example"];

function identity() {
	const sk = generateSecretKey();
	return { sk, pub: getPublicKey(sk) };
}

describe("wrap and unwrapFromPeer", () => {
	it("returns the sent text, sender npub, and inner timestamp", () => {
		const alice = identity();
		const bob = identity();
		const event = wrap("hello bob", alice.sk, bob.pub);

		const message = unwrapFromPeer(event, bob.sk, alice.pub);

		expect(message?.text).toBe("hello bob");
		expect(message?.from).toBe(nip19.npubEncode(alice.pub));
		expect(message?.id).toBe(event.id);
		expect(Math.abs((message?.ts ?? 0) - Date.now() / 1000)).toBeLessThan(5);
	});

	it("returns null for a message from someone other than the peer", () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const event = wrap("i am alice", mallory.sk, bob.pub);

		expect(unwrapFromPeer(event, bob.sk, alice.pub)).toBeNull();
	});

	it("returns null when the wrap is not addressed to us", () => {
		const alice = identity();
		const bob = identity();
		const carol = identity();
		const event = wrap("for carol", alice.sk, carol.pub);

		expect(unwrapFromPeer(event, bob.sk, alice.pub)).toBeNull();
	});

	it("returns null for an event that is not a gift wrap", () => {
		const alice = identity();
		const bob = identity();
		const note = finalizeEvent(
			{ kind: 1, created_at: 0, tags: [], content: "plain" },
			alice.sk,
		);

		expect(unwrapFromPeer(note, bob.sk, alice.pub)).toBeNull();
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

	it("returns peer messages once, drops seen ids, and moves the cursor", async () => {
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

	it("drops non-peer messages but marks them seen", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		const spam = wrap("spam", mallory.sk, bob.pub);
		await publish(pool, RELAYS, spam);

		const { messages, seen } = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] });

		expect(messages).toEqual([]);
		expect(seen.ids).toContain(spam.id);
	});

	it("sorts messages by inner timestamp", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		await publish(pool, RELAYS, wrap("first", alice.sk, bob.pub));
		await Bun.sleep(1100);
		await publish(pool, RELAYS, wrap("second", alice.sk, bob.pub));
		pool.events.reverse();

		const { messages } = await fetchNew(pool, RELAYS, bob.sk, alice.pub, { cursor: 0, ids: [] });

		expect(messages.map((m) => m.text)).toEqual(["first", "second"]);
	});
});

describe("subscribe", () => {
	it("delivers each new peer message once with the updated seen state", async () => {
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
});
