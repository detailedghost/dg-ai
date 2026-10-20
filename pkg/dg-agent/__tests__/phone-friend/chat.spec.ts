import { describe, expect, it } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import {
	fetchNew,
	LOOKBACK_SECONDS,
	publish,
	subscribe,
	ring,
	unwrapIncoming,
	wrap,
} from "../../src/phone-friend/chat";
import { MESSAGE_TTL_SECONDS } from "../../src/phone-friend/db";
import { createFakePool } from "./fake-pool";

const RELAYS = ["wss://a.example", "wss://b.example"];

function identity() {
	const sk = generateSecretKey();
	return { sk, pub: getPublicKey(sk) };
}

describe("wrap and unwrapIncoming", () => {
	it("returns the sent text, sender npub, and inner timestamp", () => {
		const alice = identity();
		const bob = identity();
		const event = wrap("hello bob", alice.sk, bob.pub);

		const message = unwrapIncoming(event, bob.sk, { contact: alice.pub }, 0);

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

		expect(unwrapIncoming(event, bob.sk, { contact: alice.pub }, 0)).toBeNull();
	});

	it("returns null when the wrap is not addressed to us", () => {
		const alice = identity();
		const bob = identity();
		const carol = identity();
		const event = wrap("for carol", alice.sk, carol.pub);

		expect(unwrapIncoming(event, bob.sk, { contact: alice.pub }, 0)).toBeNull();
	});

	it("returns null for an event that is not a gift wrap", () => {
		const alice = identity();
		const bob = identity();
		const note = finalizeEvent(
			{ kind: 1, created_at: 0, tags: [], content: "plain" },
			alice.sk,
		);

		expect(unwrapIncoming(note, bob.sk, { contact: alice.pub }, 0)).toBeNull();
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

		await fetchNew(pool, RELAYS, bob.sk, { contact: identity().pub }, { cursor, ids: [] }, () => cursor + 10);

		expect(pool.filters[0]).toEqual({
			kinds: [1059],
			"#p": [bob.pub],
			since: cursor - LOOKBACK_SECONDS,
		});
		expect(LOOKBACK_SECONDS).toBe(172800);
	});

	it("never queries further back than the message ttl, even with an old cursor", async () => {
		const bob = identity();
		const pool = createFakePool();
		const now = 1_800_000_000;

		await fetchNew(pool, RELAYS, bob.sk, { contact: identity().pub }, { cursor: 0, ids: [] }, () => now);

		expect(pool.filters[0]?.since).toBe(now - MESSAGE_TTL_SECONDS);
	});

	it("returns contact messages once, drops seen ids, and moves the cursor", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		await publish(pool, RELAYS, wrap("one", alice.sk, bob.pub));
		await publish(pool, RELAYS, wrap("two", alice.sk, bob.pub));
		const now = Math.floor(Date.now() / 1000);

		const first = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor: 0, ids: [] }, () => now);
		const second = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, first.seen, () => now + 1);

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

		const { messages } = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor, ids: [] }, () => cursor);

		expect(messages.map((m) => m.text)).toEqual(["late"]);
	});

	it("drops non-contact messages and keeps their ids out of the saved seen list", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		const spam = wrap("spam", mallory.sk, bob.pub);
		await publish(pool, RELAYS, spam);

		const { messages, seen } = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor: 0, ids: [] });

		expect(messages).toEqual([]);
		expect(seen.ids).not.toContain(spam.id);
	});

	it("keeps a contact id seen after a stranger floods past the id limit", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		await publish(pool, ["wss://a.example"], wrap("real", alice.sk, bob.pub));
		const first = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor: 0, ids: [] });
		const junk = wrap("x", mallory.sk, bob.pub);
		for (let i = 0; i < 2001; i += 1) {
			pool.events.push({ ...junk, id: i.toString(16).padStart(64, "0"), pubkey: "0".repeat(64) });
		}

		const second = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, first.seen);
		const third = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, second.seen);

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

		const { messages } = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor: 0, ids: [] });

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
		const sub = subscribe(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor: 0, ids: [] }, (message, seen) => {
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
		const sub = subscribe(pool, RELAYS, bob.sk, { contact: alice.pub }, { cursor: 0, ids: [] }, (message, seen) => {
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

describe("calls on an invite", () => {
	const secret = "cd".repeat(32);
	const invite = { secret, expiresAt: 5_000 };

	it("accepts a ring with the invite secret from a new sender and marks it a call", () => {
		const alice = identity();
		const bob = identity();

		const message = unwrapIncoming(ring("hello", alice.sk, bob.pub, secret), bob.sk, { invite }, 1_000);

		expect(message).toMatchObject({ text: "hello", from: nip19.npubEncode(alice.pub), call: true });
	});

	it("drops a ring with a wrong secret", () => {
		const alice = identity();
		const bob = identity();

		expect(unwrapIncoming(ring("hi", alice.sk, bob.pub, "ef".repeat(32)), bob.sk, { invite }, 1_000)).toBeNull();
	});

	it("drops a ring after the invite expires", () => {
		const alice = identity();
		const bob = identity();

		expect(unwrapIncoming(ring("hi", alice.sk, bob.pub, secret), bob.sk, { invite }, 5_000)).toBeNull();
	});

	it("drops a plain message from a stranger while an invite is pending", () => {
		const alice = identity();
		const bob = identity();

		expect(unwrapIncoming(wrap("hi", alice.sk, bob.pub), bob.sk, { invite }, 1_000)).toBeNull();
	});

	it("pairs the first caller in a batch and drops a second caller with the same secret", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		const at = (sk: Uint8Array, content: string, created_at: number, tags: string[][]) =>
			nip59.wrapEvent({ kind: 14, content, created_at, tags: [["p", bob.pub], ...tags] }, sk, bob.pub);
		pool.events.push(
			at(mallory.sk, "late caller", 1_200, [["dg-call", secret]]),
			at(alice.sk, "hello", 1_000, [["dg-call", secret]]),
			at(alice.sk, "second line", 1_100, []),
		);

		const result = await fetchNew(pool, RELAYS, bob.sk, { invite }, { cursor: 0, ids: [] }, () => 1_300);

		expect(result.messages.map((m) => [m.text, m.call ?? false])).toEqual([
			["hello", true],
			["second line", false],
		]);
		expect(result.gate).toEqual({ contact: alice.pub });
	});

	it("lets a call on a new invite replace the old contact", async () => {
		const alice = identity();
		const bob = identity();
		const carol = identity();
		const pool = createFakePool();
		await publish(pool, ["wss://a"], ring("new number", carol.sk, bob.pub, secret));

		const result = await fetchNew(pool, RELAYS, bob.sk, { contact: alice.pub, invite }, { cursor: 0, ids: [] }, () => 1_000);

		expect(result.messages).toMatchObject([{ text: "new number", call: true }]);
		expect(result.gate).toEqual({ contact: carol.pub });
	});

	it("a live listener accepts a call, then delivers the next message from the new contact only", async () => {
		const alice = identity();
		const bob = identity();
		const mallory = identity();
		const pool = createFakePool();
		const received: { text: string; call?: true }[] = [];
		const gates: unknown[] = [];
		const sub = subscribe(pool, RELAYS, bob.sk, { invite }, { cursor: 0, ids: [] }, (message, _seen, gate) => {
			received.push(message);
			gates.push(gate);
		}, () => 1_000);

		await publish(pool, ["wss://a"], ring("hello", alice.sk, bob.pub, secret));
		await publish(pool, ["wss://a"], ring("me too", mallory.sk, bob.pub, secret));
		await publish(pool, ["wss://a"], wrap("next", alice.sk, bob.pub));
		sub.close();

		expect(received.map((m) => [m.text, m.call ?? false])).toEqual([
			["hello", true],
			["next", false],
		]);
		expect(gates[0]).toEqual({ contact: alice.pub });
	});
});
