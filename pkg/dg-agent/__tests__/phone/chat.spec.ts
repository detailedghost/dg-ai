import { describe, expect, it } from "bun:test";
import { generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import {
	addBounded,
	CALL_TAG,
	capIds,
	fetchNew,
	type Gate,
	LOOKBACK_SECONDS,
	pickKey,
	publish,
	ring,
	SELF_NAME_TAG,
	subscribe,
	unwrapIncoming,
	wrap,
} from "../../src/phone/chat";
import { MESSAGE_TTL_SECONDS } from "../../src/phone/db";
import { createFakePool } from "./fake-pool";

const RELAYS = ["wss://a.example", "wss://b.example"];

function identity(id = "k") {
	const sk = generateSecretKey();
	return { id, sk, pub: getPublicKey(sk) };
}

function emptyGate(): Gate {
	return { contacts: new Map(), secrets: { number: "", invites: [] } };
}

function gateWithContact(contactPub: string, handle = "velora"): Gate {
	return { contacts: new Map([[contactPub, { npub: nip19.npubEncode(contactPub), handle }]]), secrets: { number: "", invites: [] } };
}

describe("wrap and unwrapIncoming", () => {
	it("returns the sent text, sender npub, and inner timestamp for a known contact", () => {
		const alice = identity();
		const bob = identity();
		const event = wrap("hello bob", alice.sk, bob.pub);

		const admitted = unwrapIncoming(event, [bob], gateWithContact(alice.pub), 0);

		expect(admitted?.message.text).toBe("hello bob");
		expect(admitted?.message.from).toBe(nip19.npubEncode(alice.pub));
		expect(admitted?.message.id).toBe(event.id);
		expect(admitted?.message.call).toBeUndefined();
		expect(Math.abs((admitted?.message.ts ?? 0) - Date.now() / 1000)).toBeLessThan(5);
	});

	it("drops a message from an unknown sender with no secret", () => {
		const alice = identity();
		const bob = identity();
		const event = wrap("i am a stranger", alice.sk, bob.pub);

		expect(unwrapIncoming(event, [bob], emptyGate(), 0)).toBeNull();
	});

	it("is ignored before decrypt when no held key matches the wrap's p tag", () => {
		const alice = identity();
		const bob = identity();
		const carol = identity();
		const event = wrap("for carol", alice.sk, carol.pub);

		expect(pickKey(event, [bob])).toBeUndefined();
		expect(unwrapIncoming(event, [bob], gateWithContact(alice.pub), 0)).toBeNull();
	});

	it("pickKey finds the held key a wrap addresses and nothing else", () => {
		const bob = identity("default");
		const carol = identity("work");
		const event = wrap("hi", identity().sk, carol.pub);

		expect(pickKey(event, [bob, carol])?.id).toBe("work");
		expect(pickKey(event, [bob])).toBeUndefined();
	});
});

describe("publish", () => {
	it("returns only the relays that accepted the event", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool([RELAYS[1]]);

		const result = await publish(pool, RELAYS, wrap("hi", alice.sk, bob.pub));

		expect(result.ok).toEqual([RELAYS[1]]);
		expect(result.unconfirmed).toEqual([]);
		expect(result.failed).toEqual([{ relay: RELAYS[0], reason: `${RELAYS[0]} refused` }]);
	});

	it("returns an empty list when every relay refuses", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool([]);

		const result = await publish(pool, RELAYS, wrap("hi", alice.sk, bob.pub));

		expect(result.ok).toEqual([]);
		expect(result.unconfirmed).toEqual([]);
		expect(result.failed.map((failure) => failure.relay)).toEqual(RELAYS);
	});
});

describe("fetchNew", () => {
	it("queries gift wraps for every held key with a two-day lookback before the cursor", async () => {
		const bob = identity();
		const pool = createFakePool();
		const cursor = 1_800_000_000;

		await fetchNew(pool, RELAYS, [bob], gateWithContact(identity().pub), { cursor, ids: [] }, () => cursor + 10);

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

		await fetchNew(pool, RELAYS, [bob], emptyGate(), { cursor: 0, ids: [] }, () => now);

		expect(pool.filters[0]?.since).toBe(now - MESSAGE_TTL_SECONDS);
	});

	it("filters on every held key's pubkey at once", async () => {
		const bob = identity("default");
		const work = identity("work");
		const pool = createFakePool();

		await fetchNew(pool, RELAYS, [bob, work], emptyGate(), { cursor: 0, ids: [] }, () => 1_000);

		expect(pool.filters[0]?.["#p"]).toEqual([bob.pub, work.pub]);
	});

	it("returns contact messages once, drops seen ids, and moves the cursor", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		await publish(pool, RELAYS, wrap("one", alice.sk, bob.pub));
		await publish(pool, RELAYS, wrap("two", alice.sk, bob.pub));
		const now = Math.floor(Date.now() / 1000);

		const first = await fetchNew(pool, RELAYS, [bob], gateWithContact(alice.pub), { cursor: 0, ids: [] }, () => now);
		const second = await fetchNew(pool, RELAYS, [bob], gateWithContact(alice.pub), first.seen, () => now + 1);

		expect(first.messages.map((m) => m.text).sort()).toEqual(["one", "two"]);
		expect(first.seen.cursor).toBe(now);
		expect(second.messages).toEqual([]);
		expect(second.seen.cursor).toBe(now + 1);
	});

	it("drops non-admitted messages and keeps their ids out of the saved seen list", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const spam = wrap("spam", alice.sk, bob.pub);
		await publish(pool, RELAYS, spam);

		const { messages, seen } = await fetchNew(pool, RELAYS, [bob], emptyGate(), { cursor: 0, ids: [] });

		expect(messages).toEqual([]);
		expect(seen.ids).not.toContain(spam.id);
	});

	it("sorts messages by inner timestamp", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const at = (content: string, created_at: number) =>
			nip59.createWrap(
				nip59.createSeal(nip59.createRumor({ kind: 14, content, created_at, tags: [["p", bob.pub]] }, alice.sk), alice.sk, bob.pub),
				bob.pub,
			);
		pool.events.push(at("second", 2_000), at("first", 1_000));

		const { messages } = await fetchNew(pool, RELAYS, [bob], gateWithContact(alice.pub), { cursor: 0, ids: [] }, () => 2_005);

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
		const sub = subscribe(pool, RELAYS, [bob], () => gateWithContact(alice.pub), { cursor: 0, ids: [] }, (message, seen) => {
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
		const sub = subscribe(pool, RELAYS, [bob], () => gateWithContact(alice.pub), { cursor: 0, ids: [] }, (message) => {
			received.push(message.text);
		});

		await publish(pool, RELAYS, wrap("spam", mallory.sk, bob.pub));
		await publish(pool, RELAYS, wrap("real", alice.sk, bob.pub));
		sub.close();

		expect(received).toEqual(["real"]);
	});

	it("tries a fresh gate once when the first look misses, and admits that same ring", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const secret = "ab".repeat(32);
		const received: string[] = [];
		const drops: { reason: string; pubkeyPrefix?: string }[] = [];
		let reads = 0;
		const sub = subscribe(
			pool,
			RELAYS,
			[bob],
			() => {
				reads += 1;
				return emptyGate();
			},
			{ cursor: 0, ids: [] },
			(message) => {
				received.push(message.text);
			},
			() => 1_000,
			{
				reread: () => {
					reads += 1;
					return { contacts: new Map(), secrets: { number: "", invites: [{ secret, expiresAt: 5_000, name: "barron" }] } };
				},
				onDrop: (drop) => drops.push(drop),
			},
		);

		await publish(pool, RELAYS, ring("hello-barron", alice.sk, bob.pub, secret, "x"));
		sub.close();

		expect(received).toEqual(["hello-barron"]);
		expect(reads).toBe(2);
		expect(drops).toEqual([]);
	});

	it("does not reread a gate that already admits the ring", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		let rereads = 0;
		const sub = subscribe(
			pool,
			RELAYS,
			[bob],
			() => gateWithContact(alice.pub),
			{ cursor: 0, ids: [] },
			() => {},
			() => 1_000,
			{ reread: () => { rereads += 1; return emptyGate(); } },
		);

		await publish(pool, RELAYS, wrap("already known", alice.sk, bob.pub));
		sub.close();

		expect(rereads).toBe(0);
	});

	it("reports an unmatched ring with a pubkey prefix and without the text or the secret", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const secret = "cd".repeat(32);
		const drops: { reason: string; pubkeyPrefix?: string; id: string }[] = [];
		const sub = subscribe(
			pool,
			RELAYS,
			[bob],
			() => emptyGate(),
			{ cursor: 0, ids: [] },
			() => {},
			() => 1_000,
			{ onDrop: (drop) => drops.push(drop) },
		);
		const event = ring("secret-body-text", alice.sk, bob.pub, secret, "x");

		await publish(pool, RELAYS, event);
		await publish(pool, RELAYS, event);
		sub.close();

		expect(drops).toHaveLength(1);
		expect(drops[0]?.reason).toBe("no matching contact or invite");
		expect(drops[0]?.pubkeyPrefix).toBe(alice.pub.slice(0, 8));
		expect(drops[0]?.pubkeyPrefix).not.toBe(alice.pub);
		const encoded = JSON.stringify(drops);
		expect(encoded).not.toContain("secret-body-text");
		expect(encoded).not.toContain(secret);
	});

	it("re-reads the gate for every event, so a contact added mid-subscription is admitted without a restart", async () => {
		const alice = identity();
		const bob = identity();
		const pool = createFakePool();
		const received: string[] = [];
		let gate = emptyGate();
		const sub = subscribe(pool, RELAYS, [bob], () => gate, { cursor: 0, ids: [] }, (message) => {
			received.push(message.text);
		});

		await publish(pool, RELAYS, wrap("too early", alice.sk, bob.pub));
		gate = gateWithContact(alice.pub);
		await publish(pool, RELAYS, wrap("now a contact", alice.sk, bob.pub));
		sub.close();

		expect(received).toEqual(["now a contact"]);
	});
});

describe("the number secret (reusable, no expiry)", () => {
	function gateWithNumber(secret: string): Gate {
		return { contacts: new Map(), secrets: { number: secret, invites: [] } };
	}
	const secret = "cd".repeat(32);

	it("admits a new caller as a contact, flags the message call, and names them from dg-as", () => {
		const alice = identity();
		const bob = identity();

		const admitted = unwrapIncoming(ring("hello", alice.sk, bob.pub, secret, "grok"), [bob], gateWithNumber(secret), 1_000);

		expect(admitted?.message).toMatchObject({ text: "hello", from: nip19.npubEncode(alice.pub), call: true });
		expect(admitted?.newContact).toMatchObject({ npub: nip19.npubEncode(alice.pub), via: "number", suggestedHandle: "grok", keyId: bob.id });
		expect(admitted?.gate.contacts.get(alice.pub)).toEqual({ npub: nip19.npubEncode(alice.pub), handle: "grok" });
	});

	it("drops a ring with a wrong secret", () => {
		const alice = identity();
		const bob = identity();

		expect(unwrapIncoming(ring("hi", alice.sk, bob.pub, "ef".repeat(32), "grok"), [bob], gateWithNumber(secret), 1_000)).toBeNull();
	});

	it("drops the old secret once the number has rotated to a new one", () => {
		const alice = identity();
		const bob = identity();
		const rotated = gateWithNumber("ff".repeat(32));

		expect(unwrapIncoming(ring("hi", alice.sk, bob.pub, secret, "grok"), [bob], rotated, 1_000)).toBeNull();
		expect(unwrapIncoming(ring("hi", alice.sk, bob.pub, "ff".repeat(32), "grok"), [bob], rotated, 1_000)).toMatchObject({
			message: { call: true },
		});
	});

	it("admits two different strangers with the same reusable secret in one batch", async () => {
		const alice = identity();
		const mallory = identity();
		const bob = identity();
		const pool = createFakePool();
		await publish(pool, RELAYS, ring("first", alice.sk, bob.pub, secret, "alice"));
		await publish(pool, RELAYS, ring("second", mallory.sk, bob.pub, secret, "mallory"));

		const { messages, newContacts } = await fetchNew(pool, RELAYS, [bob], gateWithNumber(secret), { cursor: 0, ids: [] }, () => 2_000);

		expect(messages.map((m) => m.text).sort()).toEqual(["first", "second"]);
		expect(newContacts.map((c) => c.suggestedHandle).sort()).toEqual(["alice", "mallory"]);
	});

	it("a known contact's ring with the number secret is a silent re-accept, not flagged call", () => {
		const alice = identity();
		const bob = identity();
		const gate = { contacts: new Map([[alice.pub, { npub: nip19.npubEncode(alice.pub), handle: "work-alice" }]]), secrets: { number: secret, invites: [] } };

		const admitted = unwrapIncoming(ring("hi again", alice.sk, bob.pub, secret, "alice"), [bob], gate, 1_000);

		expect(admitted?.message.call).toBeUndefined();
		expect(admitted?.reaccept).toEqual({ npub: nip19.npubEncode(alice.pub), keyId: bob.id });
		expect(admitted?.newContact).toBeUndefined();
	});
});

describe("invite secrets (one-time)", () => {
	function gateWithInvite(secret: string, name?: string): Gate {
		return { contacts: new Map(), secrets: { number: "", invites: [{ secret, expiresAt: 5_000, name }] } };
	}
	const secret = "11".repeat(32);

	it("admits the first caller and names them from the invite, flagged call", () => {
		const alice = identity();
		const bob = identity();

		const admitted = unwrapIncoming(ring("hello", alice.sk, bob.pub, secret, "ignored"), [bob], gateWithInvite(secret, "velora"), 1_000);

		expect(admitted?.message.call).toBe(true);
		expect(admitted?.newContact).toMatchObject({ via: "invite", suggestedHandle: "velora", inviteSecret: secret });
	});

	it("carries the invite's own relays onto the new contact, not the gate's default relays", () => {
		const alice = identity();
		const bob = identity();
		const gate: Gate = {
			contacts: new Map(),
			secrets: { number: "", invites: [{ secret, expiresAt: 5_000, name: "velora", relays: ["wss://invite.example"] }] },
		};

		const admitted = unwrapIncoming(ring("hello", alice.sk, bob.pub, secret, "ignored"), [bob], gate, 1_000);

		expect(admitted?.newContact?.relays).toEqual(["wss://invite.example"]);
	});

	it("leaves the new contact's relays unset when the invite has none of its own", () => {
		const alice = identity();
		const bob = identity();

		const admitted = unwrapIncoming(ring("hello", alice.sk, bob.pub, secret, "ignored"), [bob], gateWithInvite(secret, "velora"), 1_000);

		expect(admitted?.newContact?.relays).toBeUndefined();
	});

	it("falls back to the caller's dg-as tag when the invite has no pre-assigned name", () => {
		const alice = identity();
		const bob = identity();

		const admitted = unwrapIncoming(ring("hello", alice.sk, bob.pub, secret, "grok"), [bob], gateWithInvite(secret), 1_000);

		expect(admitted?.newContact?.suggestedHandle).toBe("grok");
	});

	it("drops a ring after the invite expires", () => {
		const alice = identity();
		const bob = identity();

		expect(unwrapIncoming(ring("hi", alice.sk, bob.pub, secret, "x"), [bob], gateWithInvite(secret), 5_000)).toBeNull();
	});

	it("is consumed by the first caller in a batch; a second caller with the same secret is dropped", async () => {
		const alice = identity();
		const mallory = identity();
		const bob = identity();
		const pool = createFakePool();
		await publish(pool, ["wss://a"], ring("hello", alice.sk, bob.pub, secret, "alice"));
		await publish(pool, ["wss://a"], ring("me too", mallory.sk, bob.pub, secret, "mallory"));
		await publish(pool, ["wss://a"], wrap("next", alice.sk, bob.pub));

		const result = await fetchNew(pool, RELAYS, [bob], gateWithInvite(secret), { cursor: 0, ids: [] }, () => 1_300);

		expect(result.messages.map((m) => [m.text, m.call ?? false])).toEqual([
			["hello", true],
			["next", false],
		]);
		expect(result.newContacts).toHaveLength(1);
		expect(result.gate.secrets.invites).toEqual([]);
	});

	it("leaves the other live invites alone once one is consumed", () => {
		const alice = identity();
		const bob = identity();
		const gate: Gate = {
			contacts: new Map(),
			secrets: { number: "", invites: [{ secret: "aa".repeat(32), expiresAt: 5_000 }, { secret, expiresAt: 5_000 }] },
		};

		const admitted = unwrapIncoming(ring("hi", alice.sk, bob.pub, secret, "x"), [bob], gate, 1_000);

		expect(admitted?.gate.secrets.invites).toEqual([{ secret: "aa".repeat(32), expiresAt: 5_000 }]);
	});
});

describe("the legacy-key re-accept (multi-key gate)", () => {
	it("stays on the legacy key for a plain message, and moves to the key the ring was addressed to", () => {
		const alice = identity();
		const legacyKey = identity("work");
		const numberKey = identity("default");
		const secret = "33".repeat(32);
		const gate: Gate = {
			contacts: new Map([[alice.pub, { npub: nip19.npubEncode(alice.pub), handle: "alice" }]]),
			secrets: { number: secret, invites: [] },
		};

		const plain = unwrapIncoming(wrap("hi", alice.sk, legacyKey.pub), [legacyKey, numberKey], gate, 1_000);
		expect(plain?.reaccept).toBeUndefined();
		expect(plain?.message.call).toBeUndefined();

		const reaccept = unwrapIncoming(
			ring("hi again", alice.sk, numberKey.pub, secret, "alice"),
			[legacyKey, numberKey],
			gate,
			1_000,
		);
		expect(reaccept?.reaccept).toEqual({ npub: nip19.npubEncode(alice.pub), keyId: "default" });
	});
});

describe("message ttl", () => {
	it("drops a ring whose rumor is older than the message ttl, even with a matching number secret", () => {
		const alice = identity();
		const bob = identity();
		const secret = "cd".repeat(32);
		const now = 1_800_000_000;
		const backdated = nip59.createWrap(
			nip59.createSeal(
				nip59.createRumor(
					{
						kind: 14,
						content: "late",
						created_at: now - MESSAGE_TTL_SECONDS - 1,
						tags: [["p", bob.pub], [CALL_TAG, secret], [SELF_NAME_TAG, "grok"]],
					},
					alice.sk,
				),
				alice.sk,
				bob.pub,
			),
			bob.pub,
		);

		const admitted = unwrapIncoming(backdated, [bob], { contacts: new Map(), secrets: { number: secret, invites: [] } }, now);

		expect(admitted).toBeNull();
	});

	it("still admits a ring just inside the message ttl", () => {
		const alice = identity();
		const bob = identity();
		const secret = "cd".repeat(32);
		const now = 1_800_000_000;
		const fresh = nip59.createWrap(
			nip59.createSeal(
				nip59.createRumor(
					{
						kind: 14,
						content: "on time",
						created_at: now - MESSAGE_TTL_SECONDS + 1,
						tags: [["p", bob.pub], [CALL_TAG, secret], [SELF_NAME_TAG, "grok"]],
					},
					alice.sk,
				),
				alice.sk,
				bob.pub,
			),
			bob.pub,
		);

		const admitted = unwrapIncoming(fresh, [bob], { contacts: new Map(), secrets: { number: secret, invites: [] } }, now);

		expect(admitted?.message.text).toBe("on time");
	});

	it("drops a backdated reaccept ring from an existing contact, instead of moving their key_id", () => {
		const alice = identity();
		const bob = identity();
		const secret = "cd".repeat(32);
		const now = 1_800_000_000;
		const backdated = nip59.createWrap(
			nip59.createSeal(
				nip59.createRumor(
					{
						kind: 14,
						content: "hi again",
						created_at: now - MESSAGE_TTL_SECONDS - 1,
						tags: [["p", bob.pub], [CALL_TAG, secret], [SELF_NAME_TAG, "alice"]],
					},
					alice.sk,
				),
				alice.sk,
				bob.pub,
			),
			bob.pub,
		);
		const gate: Gate = {
			contacts: new Map([[alice.pub, { npub: nip19.npubEncode(alice.pub), handle: "alice" }]]),
			secrets: { number: secret, invites: [] },
		};

		const admitted = unwrapIncoming(backdated, [bob], gate, now);

		expect(admitted).toBeNull();
	});
});

describe("capIds", () => {
	it("keeps only the most recent `limit` entries, dropping the oldest first", () => {
		expect(capIds(["a", "b", "c"], 2)).toEqual(["b", "c"]);
		expect(capIds(["a", "b"], 5)).toEqual(["a", "b"]);
		expect(capIds([], 2)).toEqual([]);
	});
});

describe("addBounded", () => {
	it("evicts the oldest entry once the set exceeds `limit`, so a long-running subscription cannot grow it without bound", () => {
		const set = new Set<string>();

		addBounded(set, "a", 2);
		addBounded(set, "b", 2);
		addBounded(set, "c", 2);

		expect(set.size).toBe(2);
		expect([...set]).toEqual(["b", "c"]);
	});
});
