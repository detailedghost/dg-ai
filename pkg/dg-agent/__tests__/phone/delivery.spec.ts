import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19, type Filter, type NostrEvent } from "nostr-tools";
import { phoneAccept, phoneNumber, phoneSay, type PhoneDeps } from "../../src/phone/commands";
import { publish, shouldSaveOutgoing, wrap, type PhonePool } from "../../src/phone/chat";
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
	keyFingerprint,
	livenessDelayMs,
	readListenerPid,
	runListener,
	type ListenerDeps,
} from "../../src/phone/listener";
import { DG_AGENT_PACKAGE_VERSION } from "../../src/version";
import {
	PUBLISH_CONFIRM_SETTING,
	addContact,
	numberKeyId,
	readAdmissionEpoch,
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
	it("keeps kind 10050 relays first, dedupes, and caps at 10", () => {
		const inbox = Array.from({ length: 11 }, (_, i) => `wss://inbox-${i}.example`);
		const set = publishRelaySet({ inbox, card: [inbox[0]!, CARD, "wss://Card.Example/"], own: [OWN, CARD] });

		expect(set).toHaveLength(MAX_PUBLISH_RELAYS);
		expect(set).toEqual(inbox.slice(0, MAX_PUBLISH_RELAYS));
		expect(set).not.toContain(CARD);
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
});

describe("lookupInboxRelays", () => {
	it("returns the newest kind 10050 list and caches it", async () => {
		const pubkey = "cd".repeat(32);
		const older = inboxEvent(pubkey, ["wss://old.example"], NOW - 10);
		const newer = inboxEvent(pubkey, [INBOX, "wss://also.example"], NOW);
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
		const contactPub = identity().pub;
		script.stored.push(inboxEvent(contactPub, [INBOX, CARD]));
		addContact(d.db, {
			npub: nip19.npubEncode(contactPub),
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
			const nextDelay = livenessDelayMs(0.5, LIVENESS_MIN_MS, LIVENESS_MAX_MS);
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

			const tick = harness.scheduled.find((entry) => entry.delay === LIVENESS_MIN_MS);
			expect(tick).toBeDefined();
			tick?.run();
			await harness.waitForLog("phone: listener resubscribe\n");

			expect(harness.db.recentMessages(10).map((row) => row.text)).toEqual(["sitting on the relay"]);
			expect(harness.db.recentMessages(10).some((row) => row.text === LISTENER_PROBE_TEXT)).toBe(false);
			expect(harness.logs.some((line) => line.includes(LISTENER_PROBE_TEXT) || line.includes("sitting on the relay"))).toBe(false);
			expect(harness.closed.length).toBeGreaterThan(0);
			expect(readAdmissionEpoch(harness.db)).toBe(epoch);
			const pid = readListenerPid(harness.paths, () => true);
			expect(pid?.version).toBe(DG_AGENT_PACKAGE_VERSION);
			expect(pid?.keys).toBe(keyFingerprint([{ id: numberKeyId(harness.db), pub: getPublicKey(harness.numberSk) }]));
		} finally {
			harness.stop();
			await harness.done;
		}
	});
});

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

function startListener(opts: { deaf?: boolean; random: () => number }) {
	const tracker = makeHomeTracker("dg-phone-live-");
	const home = tracker.freshHome();
	const paths: DgPaths = resolveDgPaths({ env: { DG_HOME: home } });
	const db = PhoneDb.open(paths, () => NOW);
	tracker.trackDb(db);
	writeRelays(db, [OWN]);
	const numberSk = createFileKey(db, numberKeyId(db)) as Uint8Array;
	writeNumber(db, { secret: "ab".repeat(32), as: "dg" });
	const inner = createFakePool();
	let deaf = opts.deaf === true;
	const closed: string[][] = [];
	const pool: PhonePool & { close(relays: string[]): void } = {
		publish(relays, event) {
			if (deaf) {
				inner.events.push(event);
				return relays.map(() => Promise.reject(new Error("publish timed out")));
			}
			return inner.publish(relays, event);
		},
		async querySync(relays, filter, params) {
			if (deaf) {
				inner.filters.push(filter);
				return [];
			}
			return inner.querySync(relays, filter, params);
		},
		subscribe(relays, filter, params) {
			if (deaf) {
				inner.filters.push(filter);
				return { close() {} };
			}
			return inner.subscribe(relays, filter, params);
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
		now: () => NOW,
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
