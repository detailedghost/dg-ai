import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { readFileSync, writeFileSync } from "node:fs";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Filter, type NostrEvent } from "nostr-tools";
import { phoneAccept, phoneNumber, phoneSay, type PhoneDeps } from "../../src/phone/commands";
import { PROBE_TOPIC, isSelfProbe, publish, shouldSaveOutgoing, wrap, wrapProbe, type PhonePool } from "../../src/phone/chat";
import {
	INBOX_RELAY_CACHE_SECONDS,
	INBOX_RELAY_KIND,
	INBOX_RELAY_LOOKUP_MS,
	MAX_PUBLISH_CONFIRM_MS,
	MAX_PUBLISH_RELAYS,
	MIN_PUBLISH_CONFIRM_MS,
	PUBLISH_CONFIRM_ENV,
	canonicalRelay,
	createPhonePool,
	lookupInboxRelays,
	publishRelaySet,
	relaysFromInboxEvent,
	resolvePublishConfirmMs,
} from "../../src/phone/delivery";
import { PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { createFileKey, type KeyClient } from "../../src/phone/keys";
import {
	LISTENER_PROBE_TEXT,
	LIVENESS_MAX_MS,
	LIVENESS_MIN_MS,
	KEY_WATCH_INTERVAL_MS,
	keyFingerprint,
	listenerPidPath,
	livenessDelayMs,
	readListenerPid,
	runListener,
	waitForId,
	type ListenerDeps,
} from "../../src/phone/listener";
import { DG_AGENT_PACKAGE_VERSION } from "../../src/version";
import {
	PUBLISH_CONFIRM_SETTING,
	addContact,
	numberKeyId,
	readAdmissionEpoch,
	readCursor,
	readInboxRelayCache,
	writeInboxRelayCache,
	writeNumber,
	writeRelays,
} from "../../src/phone/store";
import { createFakePool, freshNpub, makeHomeTracker, makePhoneDeps, parseNdjson, type FakePool } from "./fake-pool";

const CARD = "wss://card.example";
const OWN = "wss://own.example";
const INBOX = "wss://inbox.example";
const NOW = Math.floor(Date.now() / 1000);

function identity() {
	const sk = generateSecretKey();
	return { sk, pub: getPublicKey(sk) };
}

function inboxEvent(pubkey: string, relays: string[], created_at = NOW): NostrEvent {
	return {
		id: `${created_at.toString(16).padStart(64, "a").slice(0, 64)}`,
		pubkey,
		created_at,
		kind: INBOX_RELAY_KIND,
		tags: relays.map((relay) => ["relay", relay]),
		content: "",
		sig: "b".repeat(128),
	};
}

function signInbox(sk: Uint8Array, relays: string[], created_at = NOW): NostrEvent {
	return finalizeEvent(
		{ kind: INBOX_RELAY_KIND, created_at, tags: relays.map((relay) => ["relay", relay]), content: "" },
		sk,
	);
}

/** Drops nostr-tools' verified mark so `verifyEvent` checks the signature bytes. */
function unsignedCopy(event: NostrEvent, patch: Partial<NostrEvent> = {}): NostrEvent {
	return {
		id: event.id,
		pubkey: event.pubkey,
		created_at: event.created_at,
		kind: event.kind,
		tags: event.tags.map((tag) => [...tag]),
		content: event.content,
		sig: event.sig,
		...patch,
	};
}

type Mode = "ok" | "reject" | "timeout" | "slow";

function scriptedPool(modes: Record<string, Mode>, opts: { delayMs?: number; events?: NostrEvent[] } = {}) {
	const stored: NostrEvent[] = [...(opts.events ?? [])];
	const published: string[][] = [];
	const queries: Filter[] = [];
	const armed: number[] = [];
	const pool: PhonePool & { close(relays: string[]): void } = {
		async armPublishTimeout(_relays, confirmMs) {
			armed.push(confirmMs);
		},
		publish(relays, event) {
			published.push([...relays]);
			return relays.map((relay) => {
				const mode = modes[relay] ?? "ok";
				if (mode === "reject") return Promise.reject(new Error("blocked"));
				if (mode === "timeout") return Promise.reject(new Error("publish timed out"));
				if (mode === "slow") {
					stored.push(event);
					return new Promise<string>((resolve) => setTimeout(() => resolve(""), opts.delayMs ?? 40));
				}
				stored.push(event);
				return Promise.resolve("");
			});
		},
		async querySync(_relays, filter) {
			queries.push(filter);
			return stored.filter((event) => {
				if (filter.ids && !filter.ids.includes(event.id)) return false;
				if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
				if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
				return true;
			});
		},
		subscribe() {
			return { close() {} };
		},
		close() {},
	};
	return { pool, published, queries, armed, stored };
}

describe("resolvePublishConfirmMs", () => {
	it("defaults to 10s, clamps to the floor and the cap, and lets the env var beat the setting", () => {
		expect(resolvePublishConfirmMs(undefined, undefined)).toBe(10_000);
		expect(resolvePublishConfirmMs("", undefined)).toBe(10_000);
		expect(resolvePublishConfirmMs("nope", undefined)).toBe(10_000);
		expect(resolvePublishConfirmMs(undefined, 1000)).toBe(MIN_PUBLISH_CONFIRM_MS);
		expect(resolvePublishConfirmMs(undefined, 99_999)).toBe(MAX_PUBLISH_CONFIRM_MS);
		expect(resolvePublishConfirmMs("9000", 1000)).toBe(9000);
		expect(MIN_PUBLISH_CONFIRM_MS).toBeGreaterThan(4400);
	});
});

describe("publishRelaySet", () => {
	it("keeps kind 10050 relays first, dedupes, caps at 10, and still keeps a card relay and an own relay", () => {
		const inbox = Array.from({ length: 11 }, (_, i) => `wss://inbox-${i}.example`);
		const set = publishRelaySet({ inbox, card: [CARD, "wss://Card.Example/"], own: [OWN, CARD] });

		expect(set).toHaveLength(MAX_PUBLISH_RELAYS);
		expect(set.slice(0, 8)).toEqual(inbox.slice(0, 8));
		expect(set).toContain(CARD);
		expect(set).toContain(OWN);
		expect(set).not.toContain(inbox[8]);
		expect(set).not.toContain(inbox[10]);
		expect(canonicalRelay("wss://A.Example/path/")).toBe("wss://a.example/path");
		expect(canonicalRelay("https://a.example")).toBeUndefined();
	});

	it("reads relay tags off a kind 10050 event and ignores anything else", () => {
		const event = inboxEvent("ab".repeat(32), [INBOX, "wss://second.example"]);
		event.tags.push(["p", "ab".repeat(32)]);
		event.tags.push(["r", "wss://not-a-10050-tag.example"]);

		expect(relaysFromInboxEvent(event)).toEqual([INBOX, "wss://second.example"]);
	});
});

describe("publish", () => {
	const alice = identity();
	const bob = identity();

	it("counts a slow OK that lands inside the confirm window", async () => {
		const { pool, queries } = scriptedPool({ [CARD]: "slow" }, { delayMs: 30 });
		const started = Date.now();

		const report = await publish(pool, [CARD], wrap("hi", alice.sk, bob.pub), { confirmMs: 200, confirmById: false });

		expect(Date.now() - started).toBeLessThan(200);
		expect(report.ok).toEqual([CARD]);
		expect(report.unconfirmed).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(queries).toEqual([]);
		expect(shouldSaveOutgoing(report)).toBe(true);
	});

	it("upgrades a timeout to ok when a later REQ finds the stored event", async () => {
		const script = scriptedPool({ [CARD]: "timeout" });
		const event = wrap("hi", alice.sk, bob.pub);
		script.stored.push(event);

		const report = await publish(script.pool, [CARD], event, { confirmMs: 1000, confirmById: true, reqTimeoutMs: 50 });

		expect(report.ok).toEqual([CARD]);
		expect(report.unconfirmed).toEqual([]);
		expect(script.queries.some((filter) => filter.ids?.includes(event.id))).toBe(true);
	});

	it("leaves a timeout unconfirmed when the event is not stored, and records an explicit rejection", async () => {
		const slow = scriptedPool({ [CARD]: "timeout", [OWN]: "reject" });
		const started = Date.now();

		const report = await publish(slow.pool, [CARD, OWN], wrap("hi", alice.sk, bob.pub), { confirmMs: 40, reqTimeoutMs: 20 });

		expect(Date.now() - started).toBeLessThan(500);
		expect(report.unconfirmed).toEqual([CARD]);
		expect(report.failed).toEqual([{ relay: OWN, reason: "blocked" }]);
		expect(report.ok).toEqual([]);
		expect(shouldSaveOutgoing(report)).toBe(true);
		expect(slow.queries.some((filter) => filter.ids !== undefined)).toBe(true);
	});

	it("does not REQ a relay that already rejected", async () => {
		const script = scriptedPool({ [CARD]: "reject" });

		const report = await publish(script.pool, [CARD], wrap("hi", alice.sk, bob.pub), { confirmMs: 50 });

		expect(report.failed).toEqual([{ relay: CARD, reason: "blocked" }]);
		expect(report.ok).toEqual([]);
		expect(shouldSaveOutgoing(report)).toBe(false);
		expect(script.queries).toEqual([]);
	});

	it("does not upgrade a timeout when the id query is still in flight", async () => {
		const event = wrap("hi", alice.sk, bob.pub);
		let sawQuery = false;
		const pool: PhonePool = {
			publish() {
				return [Promise.reject(new Error("publish timed out"))];
			},
			querySync() {
				sawQuery = true;
				return new Promise((resolve) => setTimeout(() => resolve([event]), 250));
			},
			subscribe() {
				return { close() {} };
			},
		};
		const started = Date.now();

		const report = await publish(pool, [CARD], event, { confirmMs: 20, reqTimeoutMs: 30 });

		expect(Date.now() - started).toBeLessThan(200);
		expect(sawQuery).toBe(true);
		expect(report.unconfirmed).toEqual([CARD]);
		expect(report.ok).toEqual([]);
	});
});

describe("lookupInboxRelays", () => {
	it("returns the newest kind 10050 list and caches it", async () => {
		const sk = generateSecretKey();
		const pubkey = getPublicKey(sk);
		const older = signInbox(sk, ["wss://old.example"], NOW - 10);
		const newer = signInbox(sk, [INBOX, "wss://also.example"], NOW);
		const { pool, queries } = scriptedPool({}, { events: [older, newer] });
		let saved: string[] | undefined;
		const cache = {
			read: () => saved,
			write: (relays: string[]) => {
				saved = relays;
			},
		};

		const first = await lookupInboxRelays(pool, [OWN], pubkey, cache, 50);
		const second = await lookupInboxRelays(pool, [OWN], pubkey, cache, 50);

		expect(first).toEqual([INBOX, "wss://also.example"]);
		expect(second).toEqual(first);
		expect(queries.filter((filter) => filter.kinds?.includes(INBOX_RELAY_KIND))).toHaveLength(1);
	});

	it("caches an absent list, and does not cache a lookup that times out", async () => {
		const pubkey = "ef".repeat(32);
		let reads = 0;
		const hanging: PhonePool = {
			publish() {
				return [];
			},
			querySync() {
				reads += 1;
				return new Promise(() => {});
			},
			subscribe() {
				return { close() {} };
			},
		};
		const cache = { read: () => undefined, write: () => {} };
		const started = Date.now();

		const missed = await lookupInboxRelays(hanging, [OWN], pubkey, cache, 30);

		expect(missed).toEqual([]);
		expect(Date.now() - started).toBeLessThan(INBOX_RELAY_LOOKUP_MS);
		expect(reads).toBe(1);
		await lookupInboxRelays(hanging, [OWN], pubkey, cache, 30);
		expect(reads).toBe(2);

		const empty = scriptedPool({});
		let saved: string[] | undefined;
		const caching = {
			read: () => saved,
			write: (relays: string[]) => {
				saved = relays;
			},
		};
		expect(await lookupInboxRelays(empty.pool, [OWN], pubkey, caching, 30)).toEqual([]);
		expect(await lookupInboxRelays(empty.pool, [OWN], pubkey, caching, 30)).toEqual([]);
		expect(empty.queries.filter((filter) => filter.kinds?.includes(INBOX_RELAY_KIND))).toHaveLength(1);
	});

	it("ignores a newer kind 10050 event whose signature, author, or kind does not check out", async () => {
		const sk = generateSecretKey();
		const pubkey = getPublicKey(sk);
		const valid = signInbox(sk, [INBOX], 100);
		const forged = unsignedCopy(signInbox(sk, ["wss://evil.example"], 300), { sig: "f".repeat(128) });
		const other = generateSecretKey();
		const wrongAuthor = signInbox(other, ["wss://other.example"], 250);
		const wrongKind = unsignedCopy(signInbox(sk, ["wss://kind.example"], 400), { kind: 1 });
		const pool: PhonePool = {
			publish() {
				return [];
			},
			async querySync() {
				return [forged, wrongAuthor, wrongKind, valid];
			},
			subscribe() {
				return { close() {} };
			},
		};

		const relays = await lookupInboxRelays(pool, [OWN], pubkey, { read: () => undefined, write: () => {} }, 50);

		expect(relays).toEqual([INBOX]);
	});

	it("returns nothing and does not cache when the kind 10050 query throws", async () => {
		let reads = 0;
		const pool: PhonePool = {
			publish() {
				return [];
			},
			querySync() {
				reads += 1;
				throw new Error("relay down");
			},
			subscribe() {
				return { close() {} };
			},
		};
		let saved: string[] | undefined;
		const cache = {
			read: () => saved,
			write: (relays: string[]) => {
				saved = relays;
			},
		};

		expect(await lookupInboxRelays(pool, [OWN], "ab".repeat(32), cache, 50)).toEqual([]);
		expect(saved).toBeUndefined();
		expect(await lookupInboxRelays(pool, [OWN], "ab".repeat(32), cache, 50)).toEqual([]);
		expect(reads).toBe(2);
	});
});

describe("inbox relay cache", () => {
	const tracker = makeHomeTracker("dg-phone-cache-");

	afterEach(() => tracker.cleanup());

	it("expires an entry at the ttl boundary and keeps the one just inside it", () => {
		const home = tracker.freshHome();
		const db = PhoneDb.open(resolveDgPaths({ env: { DG_HOME: home } }), () => NOW);
		tracker.trackDb(db);
		const pubkey = "ab".repeat(32);
		writeInboxRelayCache(db, pubkey, [INBOX], 1_000);

		expect(readInboxRelayCache(db, pubkey, 1_000 + INBOX_RELAY_CACHE_SECONDS - 1, INBOX_RELAY_CACHE_SECONDS)).toEqual([INBOX]);
		expect(readInboxRelayCache(db, pubkey, 1_000 + INBOX_RELAY_CACHE_SECONDS, INBOX_RELAY_CACHE_SECONDS)).toBeUndefined();
	});
});

describe("livenessDelayMs", () => {
	it("lands on the endpoints and the midpoint of the gap", () => {
		expect(livenessDelayMs(0, 120_000, 300_000)).toBe(120_000);
		expect(livenessDelayMs(0.5, 120_000, 300_000)).toBe(210_000);
		expect(livenessDelayMs(1, 120_000, 300_000)).toBe(300_000);
		expect(livenessDelayMs(-2, 120_000, 300_000)).toBe(120_000);
		expect(livenessDelayMs(4, 120_000, 300_000)).toBe(300_000);
	});
});

describe("waitForId", () => {
	it("does not sleep when the wait is zero, and stops when the elapsed time reaches the bound", async () => {
		const absent = new Set<string>();
		const sleeps: number[] = [];
		let now = 0;
		const clock = {
			now: () => now,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				now += ms;
			},
		};

		const present = new Set(["here"]);
		expect(await waitForId(present, "here", 0, clock)).toBe(true);
		expect(sleeps).toEqual([]);

		expect(await waitForId(absent, "missing", 0, clock)).toBe(false);
		expect(sleeps).toEqual([]);

		expect(await waitForId(absent, "missing", 10, clock)).toBe(false);
		expect(sleeps).toEqual([10]);

		now = 100;
		sleeps.length = 0;
		expect(await waitForId(absent, "missing", 25, clock)).toBe(false);
		expect(sleeps).toEqual([10, 10, 10]);

		const seen = new Set<string>();
		now = 0;
		sleeps.length = 0;
		const appeared = waitForId(seen, "late", 50, {
			now: () => now,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				now += ms;
				if (now >= 20) seen.add("late");
			},
		});
		expect(await appeared).toBe(true);
		expect(sleeps).toEqual([10, 10]);
	});
});

describe("createPhonePool", () => {
	it("enables ping and reconnect on the real pool", () => {
		const pool = createPhonePool();
		expect(pool.enablePing).toBe(true);
		expect(pool.enableReconnect).toBe(true);
		pool.destroy();
	});

	it("raises publishTimeout above nostr-tools' 4.4s default and accepts a slow OK", async () => {
		const relay = startMockRelay({ okDelayMs: 40 });
		const pool = createPhonePool();
		try {
			const event = wrap("slow", identity().sk, identity().pub);
			const report = await publish(pool, [relay.url], event, { confirmMs: 10_000, confirmById: false });
			const connected = [...exposed(pool).relays.values()][0];
			expect(connected?.publishTimeout).toBe(10_000);
			expect(connected?.publishTimeout).toBeGreaterThan(4400);
			expect(report.ok).toEqual([relay.url]);
		} finally {
			pool.close([relay.url]);
			pool.destroy();
			await relay.stop();
		}
	});

	it("records an explicit OK false, and a socket that stays open without an OK as unconfirmed", async () => {
		const rejected = startMockRelay({ rejectReason: "blocked" });
		const silent = startMockRelay({ silent: true });
		const pool = createPhonePool();
		try {
			const event = wrap("no", identity().sk, identity().pub);
			const refused = await publish(pool, [rejected.url], event, { confirmMs: 1000, confirmById: false });
			expect(refused.failed).toEqual([{ relay: rejected.url, reason: "blocked" }]);

			const started = Date.now();
			const quiet = await publish(pool, [silent.url], wrap("quiet", identity().sk, identity().pub), {
				confirmMs: 80,
				confirmById: false,
			});
			expect(Date.now() - started).toBeLessThan(1000);
			expect(quiet.unconfirmed).toEqual([silent.url]);
			expect(quiet.failed).toEqual([]);
			const quietRelay = [...exposed(pool).relays.values()].find((item) => item.publishTimeout === 80);
			expect(quietRelay?.connected).toBe(true);
		} finally {
			pool.destroy();
			await rejected.stop();
			await silent.stop();
		}
	});
});

describe("phoneSay and phoneAccept delivery", () => {
	const tracker = makeHomeTracker("dg-phone-delivery-");

	afterEach(() => {
		delete process.env[PUBLISH_CONFIRM_ENV];
		tracker.cleanup();
	});

	function deps(pool: PhonePool & { close(relays: string[]): void }, out: string[]): PhoneDeps {
		const home = tracker.freshHome();
		const built = makePhoneDeps({ home, pool: pool as unknown as FakePool, write: (text) => out.push(text), now: NOW });
		tracker.trackDb(built.db);
		createFileKey(built.db, numberKeyId(built.db));
		writeRelays(built.db, [OWN]);
		return built;
	}

	it("publishes to the kind 10050 relays, the card relays, and our relays, and reuses the lookup", async () => {
		const script = scriptedPool({ [INBOX]: "ok", [CARD]: "ok", [OWN]: "ok" });
		const out: string[] = [];
		const d = deps(script.pool, out);
		const contact = identity();
		script.stored.push(signInbox(contact.sk, [INBOX, CARD]));
		addContact(d.db, {
			npub: nip19.npubEncode(contact.pub),
			handle: "ada",
			relays: [CARD],
			keyId: numberKeyId(d.db),
			addedAt: NOW,
			via: "accept",
		});

		await phoneSay("+ada", "hello", d);
		const firstQueries = script.queries.filter((filter) => filter.kinds?.includes(INBOX_RELAY_KIND)).length;
		out.length = 0;
		await phoneSay("+ada", "again", d);

		expect(script.published[0]).toEqual([INBOX, CARD, OWN]);
		expect(parseNdjson(out)[0]).toMatchObject({
			handle: "+ada",
			relays_ok: [INBOX, CARD, OWN],
			relays_unconfirmed: [],
			relays_failed: [],
		});
		expect(firstQueries).toBe(1);
		expect(script.queries.filter((filter) => filter.kinds?.includes(INBOX_RELAY_KIND))).toHaveLength(1);
		expect(d.db.recentMessages(10).map((row) => row.text).sort()).toEqual(["again", "hello"]);
	});

	it("sends on the card and our relays when kind 10050 is absent", async () => {
		const script = scriptedPool({});
		const out: string[] = [];
		const d = deps(script.pool, out);
		addContact(d.db, { npub: freshNpub(), handle: "ada", relays: [CARD], keyId: numberKeyId(d.db), addedAt: NOW, via: "accept" });

		await phoneSay("+ada", "hello", d);

		expect(script.published[0]).toEqual([CARD, OWN]);
		expect(script.queries.some((filter) => filter.kinds?.includes(INBOX_RELAY_KIND))).toBe(true);
	});

	it("saves an unconfirmed send and refuses to save when every relay rejects", async () => {
		const timeout = scriptedPool({ [CARD]: "timeout", [OWN]: "timeout" });
		const out: string[] = [];
		const saved = deps(timeout.pool, out);
		addContact(saved.db, { npub: freshNpub(), handle: "ada", relays: [CARD], keyId: numberKeyId(saved.db), addedAt: NOW, via: "accept" });

		await phoneSay("+ada", "kept", saved);

		expect(parseNdjson(out)[0]).toMatchObject({
			relays_ok: [],
			relays_unconfirmed: [CARD, OWN],
			relays_failed: [],
		});
		expect(saved.db.recentMessages(5).map((row) => row.text)).toEqual(["kept"]);

		const rejected = scriptedPool({ [CARD]: "reject", [OWN]: "reject" });
		const refused = deps(rejected.pool, []);
		addContact(refused.db, { npub: freshNpub(), handle: "ada", relays: [CARD], keyId: numberKeyId(refused.db), addedAt: NOW, via: "accept" });
		await expect(phoneSay("+ada", "dropped", refused)).rejects.toThrow("no relay accepted the message");
		expect(refused.db.recentMessages(5)).toEqual([]);
		expect(rejected.published[0]?.length).toBeGreaterThan(0);
	});

	it("names every rejected relay in the error", async () => {
		const out: string[] = [];
		const reasons: Record<string, string> = { [CARD]: "nope", [OWN]: "blocked" };
		const pool: PhonePool & { close(relays: string[]): void } = {
			publish(relays) {
				return relays.map((relay) => Promise.reject(new Error(reasons[relay] ?? "blocked")));
			},
			async querySync() {
				return [];
			},
			subscribe() {
				return { close() {} };
			},
			close() {},
		};
		const d = deps(pool, out);
		addContact(d.db, { npub: freshNpub(), handle: "ada", relays: [CARD], keyId: numberKeyId(d.db), addedAt: NOW, via: "accept" });

		await expect(phoneSay("+ada", "nope", d)).rejects.toThrow(
			`no relay accepted the message: ${CARD}: nope; ${OWN}: blocked`,
		);
	});

	it("arms the real confirm window from the setting, clamped to the floor, unless the env var is set", async () => {
		const script = scriptedPool({});
		const out: string[] = [];
		const d = deps(script.pool, out);
		d.db.set(PUBLISH_CONFIRM_SETTING, 1000);
		addContact(d.db, { npub: freshNpub(), handle: "ada", relays: [CARD], keyId: numberKeyId(d.db), addedAt: NOW, via: "accept" });

		await phoneSay("+ada", "one", d);
		expect(script.armed).toEqual([MIN_PUBLISH_CONFIRM_MS]);

		process.env[PUBLISH_CONFIRM_ENV] = "9000";
		await phoneSay("+ada", "two", d);
		expect(script.armed[1]).toBe(9000);
	});

	it("keeps a new accept when the ring is only unconfirmed, and drops it when every relay rejects", async () => {
		const ownerOut: string[] = [];
		const owner = deps(scriptedPool({}).pool, ownerOut);
		await phoneNumber({}, owner);
		const card = (parseNdjson(ownerOut)[0] as { card: string }).card;

		const peerOut: string[] = [];
		const peer = deps(timeoutAllPool(), peerOut);
		await phoneAccept(card, "hi", peer);
		const printed = parseNdjson(peerOut)[0] as { relays_unconfirmed: string[]; relays_failed: unknown[] };
		expect(printed.relays_unconfirmed.length).toBeGreaterThan(0);
		expect(printed.relays_failed).toEqual([]);
		expect(peer.db.recentMessages(5).filter((row) => row.direction === "out").map((row) => row.text)).toEqual(["hi"]);

		const rejecting = deps(rejectAllPool(), []);
		await expect(phoneAccept(card, "nope", rejecting)).rejects.toThrow("no relay accepted the call");
		expect(rejecting.db.listContacts()).toEqual([]);
	});
});

describe("runListener liveness", () => {
	it("schedules a jittered gap, logs one heartbeat, and does not store the probe", async () => {
		const draws = [0, 0.5];
		let draw = 0;
		const harness = startListener({
			random: () => draws[Math.min(draw++, draws.length - 1)] ?? 0,
		});
		try {
			await harness.ready;
			const first = harness.scheduled.find((entry) => entry.delay === livenessDelayMs(0, LIVENESS_MIN_MS, LIVENESS_MAX_MS));
			expect(first).toBeDefined();
			expect(first?.delay).not.toBe(5_000);
			first?.run();
			await harness.waitForLog("phone: listener heartbeat\n");
			const nextDelay = 210_000;
			const started = Date.now();
			while (!harness.scheduled.some((entry) => entry.delay === nextDelay)) {
				if (Date.now() - started > 2000) throw new Error(`missing jittered delay ${nextDelay}`);
				await Bun.sleep(10);
			}
			expect(nextDelay).not.toBe(first?.delay);

			expect(harness.logs.some((line) => line.includes(LISTENER_PROBE_TEXT))).toBe(false);
			expect(harness.db.recentMessages(20).some((row) => row.text === LISTENER_PROBE_TEXT)).toBe(false);
			expect(harness.logs.filter((line) => line.startsWith("phone: listener"))).toEqual(["phone: listener heartbeat\n"]);
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("resubscribes a subscription that stays open and delivers nothing, then catches up", async () => {
		const harness = startListener({ deaf: true, random: () => 0 });
		try {
			const caller = identity();
			addContact(harness.db, {
				npub: nip19.npubEncode(caller.pub),
				handle: "ada",
				relays: [OWN],
				keyId: numberKeyId(harness.db),
				addedAt: NOW,
				via: "accept",
			});
			harness.store.push(wrap("sitting on the relay", caller.sk, getPublicKey(harness.numberSk)));
			const epoch = readAdmissionEpoch(harness.db);
			await harness.ready;
			harness.clock.current = NOW + 500;

			const tick = harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS);
			expect(tick).toBeDefined();
			tick?.run();
			await harness.waitForLog("phone: listener resubscribe\n");

			expect(harness.db.recentMessages(10).map((row) => row.text)).toEqual(["sitting on the relay"]);
			expect(harness.db.recentMessages(10).some((row) => row.text === LISTENER_PROBE_TEXT)).toBe(false);
			expect(harness.logs.some((line) => line.includes(LISTENER_PROBE_TEXT) || line.includes("sitting on the relay"))).toBe(false);
			expect(harness.closed.length).toBeGreaterThan(0);
			expect(harness.subCloses()).toBeGreaterThan(0);
			expect(harness.filters.some((filter) => filter.ids !== undefined)).toBe(false);
			expect(readCursor(harness.db)).toBe(NOW + 500);
			expect(readAdmissionEpoch(harness.db)).toBe(epoch);
			const pid = readListenerPid(harness.paths, () => true);
			expect(pid?.version).toBe(DG_AGENT_PACKAGE_VERSION);
			expect(pid?.keys).toBe(keyFingerprint([{ id: numberKeyId(harness.db), pub: getPublicKey(harness.numberSk) }]));
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("does not resubscribe when every relay rejects the probe, and logs probe-failed", async () => {
		const harness = startListener({ publishMode: "reject", random: () => 0 });
		try {
			await harness.ready;
			harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS)?.run();
			await harness.waitForLog("phone: listener probe-failed\n");
			expect(harness.closed).toEqual([]);
			expect(harness.logs.some((line) => line.includes("heartbeat") || line.includes("resubscribe"))).toBe(false);
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("logs probe-failed when the probe publish throws", async () => {
		const harness = startListener({ publishMode: "throw", random: () => 0 });
		try {
			await harness.ready;
			harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS)?.run();
			await harness.waitForLog("phone: listener probe-failed\n");
			expect(harness.logs.some((line) => line.startsWith("phone: listener heartbeat"))).toBe(false);
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("probes one relay per check and rotates to the next relay", async () => {
		const other = "wss://other.example";
		const harness = startListener({ relays: [OWN, other], random: () => 0 });
		try {
			await harness.ready;
			const tick = () => harness.scheduled.filter((entry) => entry.delay === LIVENESS_MIN_MS).at(-1)?.run();
			tick();
			await harness.waitForLog("phone: listener heartbeat\n");
			tick();
			const started = Date.now();
			while (harness.published.length < 2) {
				if (Date.now() - started > 2000) throw new Error(`published ${JSON.stringify(harness.published)}`);
				await Bun.sleep(10);
			}
			expect(harness.published[0]).toEqual([OWN]);
			expect(harness.published[1]).toEqual([other]);
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("rewrites listener.pid after a liveness resubscribe", async () => {
		const harness = startListener({ deaf: true, random: () => 0 });
		try {
			await harness.ready;
			const path = listenerPidPath(harness.paths);
			const stamped = JSON.parse(readFileSync(path, "utf8")) as { relays: string[] };
			stamped.relays = ["wss://stale.example"];
			writeFileSync(path, JSON.stringify(stamped));
			harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS)?.run();
			await harness.waitForLog("phone: listener resubscribe\n");
			const rewritten = JSON.parse(readFileSync(path, "utf8")) as { relays: string[]; keys?: string };
			expect(rewritten.relays).toEqual([OWN]);
			expect(rewritten.keys).toBe(keyFingerprint([{ id: numberKeyId(harness.db), pub: getPublicKey(harness.numberSk) }]));
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("records the key-change notice and rewrites the pid when catch-up throws", async () => {
		let failQueries = false;
		const harness = startListener({ random: () => 0, failQueries: () => failQueries });
		try {
			await harness.ready;
			const replacement = identity();
			harness.db.putKey({ id: numberKeyId(harness.db), nsec: nip19.nsecEncode(replacement.sk), in_store: 0 });
			failQueries = true;
			harness.scheduled.find((entry) => entry.delay === KEY_WATCH_INTERVAL_MS)?.run();
			const started = Date.now();
			while (!harness.db.unreadMessages().some((row) => row.sender === "phone" && row.text === "key changed")) {
				if (Date.now() - started > 2000) throw new Error("key change notice was not recorded");
				await Bun.sleep(10);
			}
			const written = JSON.parse(readFileSync(listenerPidPath(harness.paths), "utf8")) as { keys?: string };
			expect(written.keys).toBe(keyFingerprint([{ id: numberKeyId(harness.db), pub: replacement.pub }]));
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("logs probe-failed and does not publish when there is no relay", async () => {
		const harness = startListener({ relays: [], random: () => 0 });
		try {
			await harness.ready;
			harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS)?.run();
			await harness.waitForLog("phone: listener probe-failed\n");
			expect(harness.published).toEqual([]);
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("signs the probe with the number key when another key is loaded first", async () => {
		const harness = startListener({
			random: () => 0,
			beforeStart: (db) => {
				createFileKey(db, "aaa");
			},
		});
		try {
			await harness.ready;
			harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS)?.run();
			await harness.waitForLog("phone: listener heartbeat\n");
			const rumor = (await import("nostr-tools")).nip17.unwrapEvent(harness.probes[0]!, harness.numberSk);
			expect(rumor.pubkey).toBe(getPublicKey(harness.numberSk));
			expect(rumor.tags).toContainEqual(["t", PROBE_TOPIC]);
		} finally {
			harness.stop();
			await harness.done;
		}
	});

	it("does not start a second probe while one check is still running", async () => {
		const harness = startListener({ publishMode: "hold", random: () => 0 });
		try {
			await harness.ready;
			const ticks = () => harness.scheduled.filter((entry) => entry.delay === LIVENESS_MIN_MS);
			ticks().at(-1)?.run();
			const started = Date.now();
			while (harness.published.length < 1) {
				if (Date.now() - started > 2000) throw new Error("probe did not start");
				await Bun.sleep(5);
			}
			ticks().at(-1)?.run();
			await Bun.sleep(30);
			expect(harness.published).toHaveLength(1);
			harness.releaseHold();
			await Bun.sleep(40);
			expect(harness.published).toHaveLength(1);
		} finally {
			harness.stop();
			await harness.done;
		}
	});
});

describe("probe catch-up after a restart", () => {
	it("does not inbox a self-probe when our npub is a contact, and still stores a real self message", async () => {
		const seen = await runCatchUp((db, sk) => {
			const pub = getPublicKey(sk);
			addContact(db, {
				npub: nip19.npubEncode(pub),
				handle: "self",
				relays: [OWN],
				keyId: numberKeyId(db),
				addedAt: NOW,
				via: "accept",
			});
			return [wrapProbe(sk, pub), wrap("real-self", sk, pub)];
		});
		expect(seen.texts).toContain("real-self");
		expect(seen.texts).not.toContain(PROBE_TOPIC);
		expect(seen.logs.some((line) => line.includes("phone: dropped"))).toBe(false);
		expect(isSelfProbe({ pubkey: seen.pub, tags: [["t", PROBE_TOPIC]] }, [seen.pub])).toBe(true);
	});

	it("does not log a drop for a self-probe when our npub is not a contact", async () => {
		const seen = await runCatchUp((db, sk) => {
			void db;
			return [wrapProbe(sk, getPublicKey(sk))];
		});
		expect(seen.texts).not.toContain(PROBE_TOPIC);
		expect(seen.logs.some((line) => line.includes("phone: dropped"))).toBe(false);
	});
});

async function runCatchUp(seed: (db: PhoneDb, sk: Uint8Array) => NostrEvent[]): Promise<{ texts: string[]; logs: string[]; pub: string }> {
	const tracker = makeHomeTracker("dg-phone-restart-");
	const home = tracker.freshHome();
	const paths = resolveDgPaths({ env: { DG_HOME: home } });
	const db = PhoneDb.open(paths, () => NOW);
	tracker.trackDb(db);
	writeRelays(db, [OWN]);
	const sk = createFileKey(db, numberKeyId(db)) as Uint8Array;
	writeNumber(db, { secret: "cd".repeat(32), as: "dg" });
	const pool = createFakePool();
	for (const event of seed(db, sk)) pool.events.push(event);
	const logs: string[] = [];
	const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		logs.push(String(chunk));
		return true;
	});
	let stopHandler: (() => void) | undefined;
	let resolveReady: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const done = runListener({
		paths,
		db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant");
		},
		createPool: () => ({ ...pool, close: () => {} }),
		now: () => NOW,
		pid: 5151,
		schedule: () => () => {},
		onSignal: (signal, handler) => {
			if (signal === "SIGTERM") {
				stopHandler = handler;
				resolveReady();
			}
		},
		liveness: { minMs: LIVENESS_MIN_MS, maxMs: LIVENESS_MAX_MS, confirmMs: 20, waitMs: 10, random: () => 0 },
	}).finally(() => {
		stderr.mockRestore();
		tracker.cleanup();
	});
	await opened;
	const texts = db.recentMessages(20).map((row) => row.text);
	stopHandler?.();
	await done;
	return { texts, logs: [...logs], pub: getPublicKey(sk) };
}

function timeoutAllPool(): PhonePool & { close(relays: string[]): void } {
	return scriptedPool(new Proxy({}, { get: () => "timeout" }) as Record<string, Mode>).pool;
}

function rejectAllPool(): PhonePool & { close(relays: string[]): void } {
	return scriptedPool(new Proxy({}, { get: () => "reject" }) as Record<string, Mode>).pool;
}

function exposed(pool: object): { relays: Map<string, { publishTimeout: number; connected: boolean }> } {
	return pool as { relays: Map<string, { publishTimeout: number; connected: boolean }> };
}

function startMockRelay(script: { okDelayMs?: number; rejectReason?: string; silent?: boolean }) {
	let connections = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, server) {
			if (server.upgrade(req)) return undefined;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open() {
				connections += 1;
			},
			message(ws, message) {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				let data: unknown;
				try {
					data = JSON.parse(text);
				} catch {
					return;
				}
				if (!Array.isArray(data)) return;
				if (data[0] === "EVENT" && data[1] && typeof data[1] === "object" && data[1] !== null && "id" in data[1]) {
					if (script.silent) return;
					const id = String((data[1] as { id: unknown }).id);
					const send = () => {
						if (script.rejectReason !== undefined) ws.send(JSON.stringify(["OK", id, false, script.rejectReason]));
						else ws.send(JSON.stringify(["OK", id, true, ""]));
					};
					if ((script.okDelayMs ?? 0) > 0) setTimeout(send, script.okDelayMs);
					else send();
					return;
				}
				if (data[0] === "REQ" && !script.silent) ws.send(JSON.stringify(["EOSE", data[1]]));
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		get connections() {
			return connections;
		},
		stop: () => server.stop(true),
	};
}

function startListener(opts: {
	deaf?: boolean;
	random: () => number;
	relays?: string[];
	publishMode?: "ok" | "reject" | "throw" | "hold";
	failQueries?: () => boolean;
	beforeStart?: (db: PhoneDb, numberSk: Uint8Array) => void;
}) {
	const tracker = makeHomeTracker("dg-phone-live-");
	const home = tracker.freshHome();
	const paths: DgPaths = resolveDgPaths({ env: { DG_HOME: home } });
	const db = PhoneDb.open(paths, () => NOW);
	tracker.trackDb(db);
	writeRelays(db, opts.relays ?? [OWN]);
	const numberSk = createFileKey(db, numberKeyId(db)) as Uint8Array;
	writeNumber(db, { secret: "ab".repeat(32), as: "dg" });
	opts.beforeStart?.(db, numberSk);
	const inner = createFakePool();
	let deaf = opts.deaf === true;
	const closed: string[][] = [];
	const published: string[][] = [];
	const probes: NostrEvent[] = [];
	let subCloses = 0;
	let releaseHold: () => void = () => {};
	const hold = new Promise<void>((resolve) => {
		releaseHold = resolve;
	});
	const clock = { current: NOW };
	const pool: PhonePool & { close(relays: string[]): void } = {
		publish(relays, event) {
			published.push([...relays]);
			probes.push(event);
			if (opts.publishMode === "throw") throw new Error("probe boom");
			if (opts.publishMode === "hold") return relays.map(() => hold.then(() => ""));
			if (opts.publishMode === "reject") return relays.map(() => Promise.reject(new Error("blocked")));
			if (deaf) {
				inner.events.push(event);
				return relays.map(() => Promise.reject(new Error("publish timed out")));
			}
			return inner.publish(relays, event);
		},
		async querySync(relays, filter, params) {
			if (opts.failQueries?.()) throw new Error("fetch down");
			if (deaf) {
				inner.filters.push(filter);
				return [];
			}
			return inner.querySync(relays, filter, params);
		},
		subscribe(relays, filter, params) {
			if (deaf) {
				inner.filters.push(filter);
				return {
					close() {
						subCloses += 1;
					},
				};
			}
			const sub = inner.subscribe(relays, filter, params);
			return {
				close() {
					subCloses += 1;
					sub.close();
				},
			};
		},
		close(relays) {
			closed.push([...relays]);
			deaf = false;
		},
	};
	const scheduled: { delay: number; run: () => void }[] = [];
	const schedule: Schedule = (delay, run) => {
		const entry = { delay, run };
		scheduled.push(entry);
		return () => {
			const index = scheduled.indexOf(entry);
			if (index >= 0) scheduled.splice(index, 1);
		};
	};
	const logs: string[] = [];
	const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		logs.push(String(chunk));
		return true;
	});
	let stopHandler: (() => void) | undefined;
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const deps: ListenerDeps = {
		paths,
		db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant");
		},
		createPool: () => pool,
		now: () => clock.current,
		pid: 4242,
		schedule,
		onSignal: (signal, handler) => {
			if (signal === "SIGTERM") {
				stopHandler = handler;
				resolveReady();
			}
		},
		liveness: {
			minMs: LIVENESS_MIN_MS,
			maxMs: LIVENESS_MAX_MS,
			confirmMs: 30,
			waitMs: 20,
			random: opts.random,
		},
	};
	const done = runListener(deps).finally(() => {
		stderr.mockRestore();
		tracker.cleanup();
	});
	return {
		db,
		paths,
		numberSk,
		scheduled,
		logs,
		closed,
		store: inner.events,
		published,
		probes,
		filters: inner.filters,
		clock,
		releaseHold,
		subCloses: () => subCloses,
		ready,
		done,
		stop: () => stopHandler?.(),
		waitForLog: async (line: string) => {
			const start = Date.now();
			while (!logs.includes(line)) {
				if (Date.now() - start > 2000) throw new Error(`missing log ${line}; saw ${logs.join(" | ")}`);
				await Bun.sleep(10);
			}
		},
	};
}
