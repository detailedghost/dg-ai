import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { publish, ring, wrap } from "../../src/phone/chat";
import { PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { createFileKey, ensureKey, keyName, markKeyInStore, type KeyClient } from "../../src/phone/keys";
import {
	claimListener,
	commandLookupFromText,
	displaceStaleLock,
	ensureListenerSubscribed,
	holderVerdict,
	isListenerArgs,
	isOurListener,
	KEY_WATCH_INTERVAL_MS,
	keyFingerprint,
	listenerClaimPath,
	listenerPidPath,
	readListenerPid,
	type ListenerDeps,
	runListener,
} from "../../src/phone/listener";
import { DG_AGENT_PACKAGE_VERSION } from "../../src/version";
import type { CommandPushTarget } from "../../src/phone/push";
import {
	addContact,
	addInvite,
	DEFAULT_NUMBER_KEY_ID,
	findContactByHandle,
	findContactByNpub,
	listContacts,
	numberKeyId,
	DEFAULT_RELAYS,
	writeListener,
	writeNumber,
	writeRelays,
} from "../../src/phone/store";
import { blockingSleep, createFakePool, type FakePool } from "./fake-pool";

const RELAYS = ["wss://a.example", "wss://b.example"];
let home: string;
let scratch: string;
let paths: DgPaths;
let db: PhoneDb;
let pool: FakePool;
/** Real wall-clock seconds: `ring`/`wrap` stamp real time on every event, and `PhoneDb` prunes by
 * age against this same clock, so the fake "now" here cannot drift from it. */
let NOW: number;

function identity() {
	const sk = generateSecretKey();
	return { sk, pub: getPublicKey(sk), npub: nip19.npubEncode(getPublicKey(sk)) };
}

function noopSchedule(): Schedule {
	return () => () => {};
}

type Harness = { onSignal: ListenerDeps["onSignal"]; ready: Promise<void>; stop: () => void };

/** Resolves once `runListener` has registered its shutdown handler: setup (keys, catch-up, the
 * hook's start-time delivery, and the live subscription) is fully done by that point. */
function captureShutdown(): Harness {
	let stopHandler: (() => void) | undefined;
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const onSignal: ListenerDeps["onSignal"] = (signal, handler) => {
		if (signal === "SIGTERM") {
			stopHandler = handler;
			resolveReady();
		}
	};
	return { onSignal, ready, stop: () => stopHandler?.() };
}

function deps(overrides: Partial<ListenerDeps> = {}): ListenerDeps {
	return {
		paths,
		db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
		createPool: () => ({ ...pool, close: () => {} }),
		now: () => NOW,
		pid: 4242,
		schedule: noopSchedule(),
		onSignal: () => {},
		...overrides,
	};
}

/** Creates the number's key (file mode, so the test can address events to it) and its secret. */
function setUpNumber(secret: string, as = "dg"): Uint8Array {
	const sk = createFileKey(db, numberKeyId(db)) as Uint8Array;
	writeNumber(db, { secret, as });
	return sk;
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

beforeEach(() => {
	NOW = Math.floor(Date.now() / 1000);
	home = mkdtempSync(join(tmpdir(), "dg-phone-listener-"));
	scratch = mkdtempSync(join(tmpdir(), "dg-phone-listener-scratch-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	db = PhoneDb.open(paths, () => NOW);
	pool = createFakePool();
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

describe("runListener", () => {
	it("catches up on a ring sent before it started, admitting a new contact and delivering it through the hook", async () => {
		const secret = "ab".repeat(32);
		const numberSk = setUpNumber(secret);
		const caller = identity();
		pool.events.push(ring("hello there", caller.sk, getPublicKey(numberSk), secret, "grok"));
		const outFile = join(scratch, "out");
		const hook: CommandPushTarget = {
			kind: "command",
			argv: [process.execPath, "-e", `await Bun.write(${JSON.stringify(outFile)}, await Bun.stdin.text());process.exit(0)`],
			timeoutMs: 2000,
		};
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ hook, onSignal }));
		await ready;
		stop();
		await run;

		const contact = findContactByHandle(db, "grok");
		expect(contact?.npub).toBe(caller.npub);
		expect(contact?.via).toBe("number");
		const payload = JSON.parse(readFileSync(outFile, "utf8"));
		expect(payload).toMatchObject({ from: caller.npub, handle: "+grok", text: "hello there", call: true });
	});

	it("does not rename a just-created contact when a follow-up from the same caller is caught up in the same batch", async () => {
		const secret = "88".repeat(32);
		const numberSk = setUpNumber(secret);
		const caller = identity();
		pool.events.push(ring("hello there", caller.sk, getPublicKey(numberSk), secret, "grok"));
		pool.events.push(wrap("a follow-up before you were even listening", caller.sk, getPublicKey(numberSk)));
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		stop();
		await run;

		expect(listContacts(db).filter((c) => c.npub === caller.npub)).toHaveLength(1);
		expect(findContactByHandle(db, "grok")?.npub).toBe(caller.npub);
		expect(findContactByHandle(db, "grok-2")).toBeUndefined();
	});

	it("falls back to the default handle when a peer's dg-as tag is not a valid handle", async () => {
		const secret = "99".repeat(32);
		const numberSk = setUpNumber(secret);
		const caller = identity();
		pool.events.push(ring("hi", caller.sk, getPublicKey(numberSk), secret, "Not A Handle!"));
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		stop();
		await run;

		expect(findContactByNpub(db, caller.npub)?.handle).toBe("dg");
	});

	it("admits a live ring the same way once the subscription is open", async () => {
		const secret = "cd".repeat(32);
		const numberSk = setUpNumber(secret);
		const caller = identity();
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		await publish(pool, RELAYS, ring("hi", caller.sk, getPublicKey(numberSk), secret, "velora"));
		await waitUntil(() => findContactByHandle(db, "velora") !== undefined);
		stop();
		await run;

		expect(findContactByHandle(db, "velora")?.npub).toBe(caller.npub);
	});

	it("consumes the matching invite when a stranger rings with an invite secret instead of the number secret", async () => {
		const numberSk = setUpNumber("ff".repeat(32));
		const inviteSecret = "11".repeat(32);
		addInvite(db, { secret: inviteSecret, expiresAt: NOW + 10_000, asName: "dg", name: "preassigned", keyId: DEFAULT_NUMBER_KEY_ID });
		const caller = identity();
		pool.events.push(ring("hi", caller.sk, getPublicKey(numberSk), inviteSecret, "x"));
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		stop();
		await run;

		expect(findContactByHandle(db, "preassigned")?.npub).toBe(caller.npub);
	});

	it("records an invite-admitted contact with the invite's own relays, not the default relays", async () => {
		const numberSk = setUpNumber("ff".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		const inviteSecret = "22".repeat(32);
		addInvite(db, {
			secret: inviteSecret,
			expiresAt: NOW + 10_000,
			asName: "dg",
			name: "velora",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		const caller = identity();
		pool.events.push(ring("hi", caller.sk, getPublicKey(numberSk), inviteSecret, "x"));
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		stop();
		await run;

		expect(findContactByHandle(db, "velora")?.relays).toEqual(["wss://invite.example"]);
	});

	it("moves a known contact's key id when they ring the number secret from a new key", async () => {
		const secret = "33".repeat(32);
		const numberSk = setUpNumber(secret);
		await ensureKey(deps(), "work");
		const caller = identity();
		addContact(db, { npub: caller.npub, handle: "alice", relays: RELAYS, keyId: "work", addedAt: NOW, via: "accept" });
		pool.events.push(ring("hi again", caller.sk, getPublicKey(numberSk), secret, "alice"));
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		stop();
		await run;

		expect(findContactByNpub(db, caller.npub)?.keyId).toBe(numberKeyId(db));
	});

	it("drops a stranger's wrap: nothing is stored and the hook never runs", async () => {
		setUpNumber("44".repeat(32));
		const mallory = identity();
		const victim = identity();
		pool.events.push(wrap("spam", mallory.sk, victim.pub));
		const ranFile = join(scratch, "ran");
		const hook: CommandPushTarget = {
			kind: "command",
			argv: [process.execPath, "-e", `await Bun.write(${JSON.stringify(ranFile)}, "ran")`],
			timeoutMs: 2000,
		};
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ hook, onSignal }));
		await ready;
		stop();
		await run;

		expect(db.recentMessages(10)).toEqual([]);
		expect(existsSync(ranFile)).toBe(false);
	});

	it("writes the listener pid file with the hook's argv and timeout, and removes it on shutdown", async () => {
		const sk = setUpNumber("55".repeat(32));
		const hook: CommandPushTarget = { kind: "command", argv: ["notify-send"], timeoutMs: 7000 };
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ hook, onSignal, pid: 9999 }));
		await ready;

		const written = JSON.parse(readFileSync(listenerPidPath(paths), "utf8"));
		expect(written).toEqual({
			pid: 9999,
			since: NOW,
			hook: { argv: ["notify-send"], timeoutS: 7 },
			relays: DEFAULT_RELAYS,
			version: DG_AGENT_PACKAGE_VERSION,
			keys: keyFingerprint([{ id: numberKeyId(db), pub: getPublicKey(sk) }]),
		});

		stop();
		await run;

		expect(existsSync(listenerPidPath(paths))).toBe(false);
	});

	it("delivers already-stored unread rows oldest first before the live subscription opens", async () => {
		setUpNumber("77".repeat(32));
		const sender = identity();
		addContact(db, { npub: sender.npub, handle: "aaa", relays: RELAYS, keyId: numberKeyId(db), addedAt: NOW, via: "accept" });
		db.addMessage({ id: "m1", direction: "in", ts: NOW - 20, sender: sender.npub, contact: sender.npub, text: "first", call: 0 });
		db.addMessage({ id: "m2", direction: "in", ts: NOW - 10, sender: sender.npub, contact: sender.npub, text: "second", call: 0 });
		const outFile = join(scratch, "order");
		const hook: CommandPushTarget = {
			kind: "command",
			argv: [process.execPath, "-e", `await Bun.write(${JSON.stringify(outFile)}, (await Bun.file(${JSON.stringify(outFile)}).exists()?await Bun.file(${JSON.stringify(outFile)}).text():'')+(await Bun.stdin.text())+'\\n');process.exit(0)`],
			timeoutMs: 2000,
		};
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ hook, onSignal }));
		await ready;
		stop();
		await run;

		expect(db.unreadMessages()).toEqual([]);
		const order = readFileSync(outFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { id: string }).id);
		expect(order).toEqual(["m1", "m2"]);
	});

	it("keeps the subscription open and still stores the next message after a hook call is killed by its timeout", async () => {
		const numberSk = setUpNumber("66".repeat(32));
		const alice = identity();
		const bob = identity();
		addContact(db, { npub: alice.npub, handle: "alice", relays: RELAYS, keyId: numberKeyId(db), addedAt: NOW, via: "accept" });
		addContact(db, { npub: bob.npub, handle: "bob", relays: RELAYS, keyId: numberKeyId(db), addedAt: NOW, via: "accept" });
		const sleepyHook: CommandPushTarget = {
			kind: "command",
			argv: [process.execPath, "-e", "await new Promise((r) => setTimeout(r, 5000))"],
			timeoutMs: 150,
		};
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ hook: sleepyHook, onSignal }));
		await ready;
		await publish(pool, RELAYS, wrap("too slow for the hook", alice.sk, getPublicKey(numberSk)));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await publish(pool, RELAYS, wrap("still arrives", bob.sk, getPublicKey(numberSk)));
		await waitUntil(() => db.recentMessages(10).length >= 2);
		await waitUntil(() => (db.recentMessages(10).find((m) => m.text === "too slow for the hook")?.attempts ?? 0) > 0);

		stop();
		await run;

		expect(db.recentMessages(10).map((m) => m.text).sort()).toEqual(["still arrives", "too slow for the hook"]);
		expect(db.recentMessages(10).find((m) => m.text === "too slow for the hook")?.attempts).toBeGreaterThan(0);
	});

	it("resubscribes when a key appears and records one local notice", async () => {
		const sk = setUpNumber("11".repeat(32));
		const scheduled: { delay: number; run: () => void }[] = [];
		const schedule: Schedule = (delay, run) => {
			const entry = { delay, run };
			scheduled.push(entry);
			return () => {
				const index = scheduled.indexOf(entry);
				if (index >= 0) scheduled.splice(index, 1);
			};
		};
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal, schedule }));
		await ready;
		expect(pool.listeners).toHaveLength(1);
		expect(db.unreadMessages().filter((row) => row.sender === "phone")).toEqual([]);

		const extra = identity();
		db.putKey({ id: "extra", nsec: nip19.nsecEncode(extra.sk), in_store: 0 });
		const watch = scheduled.find((entry) => entry.delay === KEY_WATCH_INTERVAL_MS);
		expect(watch).toBeDefined();
		watch?.run();
		await waitUntil(() => pool.filters.some((filter) => filter["#p"]?.includes(extra.pub)));

		expect(pool.listeners).toHaveLength(1);
		expect(pool.filters.some((filter) => filter["#p"]?.includes(getPublicKey(sk)))).toBe(true);
		const notices = db.unreadMessages().filter((row) => row.sender === "phone").map((row) => row.text);
		expect(notices).toEqual(["key changed"]);

		stop();
		await run;
	});

	it("keeps its subscription while a store key is unreadable, then resubscribes from the latest cursor", async () => {
		const sk = setUpNumber("11".repeat(32));
		const storeSk = generateSecretKey();
		const storePub = getPublicKey(storeSk);
		markKeyInStore(db, "b", storeSk);
		let down = false;
		let storeReads = 0;
		const nsec = nip19.nsecEncode(storeSk);
		const scheduled: { delay: number; run: () => void }[] = [];
		const schedule: Schedule = (delay, run) => {
			const entry = { delay, run };
			scheduled.push(entry);
			return () => {
				const index = scheduled.indexOf(entry);
				if (index >= 0) scheduled.splice(index, 1);
			};
		};
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(
			deps({
				onSignal,
				schedule,
				grantClient: (): KeyClient => {
					storeReads += 1;
					if (down) throw new Error("store down");
					return {
						async get(name) {
							return name === keyName("b") ? { value: nsec, meta: {}, updatedAt: "" } : undefined;
						},
						async set() {},
						async delete() {
							return false;
						},
						async grant(prefix) {
							return { prefix, path: "" };
						},
						close() {},
					};
				},
			}),
		);
		await ready;
		const initialSince = pool.filters[1]?.since ?? 0;
		expect(pool.listeners).toHaveLength(1);
		expect(pool.filters[1]?.["#p"]).toEqual(expect.arrayContaining([getPublicKey(sk), storePub]));
		const filtersAtStart = pool.filters.length;

		down = true;
		const readsWhileDown = storeReads;
		scheduled.find((entry) => entry.delay === KEY_WATCH_INTERVAL_MS)?.run();
		await waitUntil(() => storeReads > readsWhileDown);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pool.filters).toHaveLength(filtersAtStart);
		expect(pool.listeners).toHaveLength(1);
		expect(db.unreadMessages().filter((row) => row.sender === "phone")).toEqual([]);

		down = false;
		const alice = identity();
		addContact(db, { npub: alice.npub, handle: "alice", relays: RELAYS, keyId: numberKeyId(db), addedAt: NOW, via: "accept" });
		NOW += 50_000;
		await publish(pool, RELAYS, wrap("ping", alice.sk, getPublicKey(sk)));
		const readsWhileBack = storeReads;
		scheduled.find((entry) => entry.delay === KEY_WATCH_INTERVAL_MS)?.run();
		await waitUntil(() => storeReads > readsWhileBack);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pool.filters).toHaveLength(filtersAtStart);
		expect(pool.listeners).toHaveLength(1);
		expect(db.unreadMessages().filter((row) => row.sender === "phone")).toEqual([]);

		const extra = identity();
		db.putKey({ id: "extra", nsec: nip19.nsecEncode(extra.sk), in_store: 0 });
		scheduled.find((entry) => entry.delay === KEY_WATCH_INTERVAL_MS)?.run();
		await waitUntil(() => pool.filters.length > filtersAtStart);

		expect(pool.listeners).toHaveLength(1);
		const resubscribed = pool.filters.at(-1);
		expect(resubscribed?.since).toBeGreaterThan(initialSince);
		expect(resubscribed?.["#p"]).toEqual(expect.arrayContaining([getPublicKey(sk), storePub, extra.pub]));
		expect(db.unreadMessages().filter((row) => row.sender === "phone").map((row) => row.text)).toEqual(["key changed"]);

		stop();
		await run;
	});
});

describe("isListenerArgs", () => {
	it("matches the current and the old listener's argv, and nothing else", () => {
		expect(isListenerArgs(["dg-agent", "phone", "__run"])).toBe(true);
		expect(isListenerArgs(["dg-agent", "phone-friend", "__run"])).toBe(true);
		expect(isListenerArgs(["dg-agent", "phone", "number"])).toBe(false);
	});
});

describe("readListenerPid", () => {
	it("ignores a pid file whose pid is not a safe positive integer, instead of trusting it", () => {
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: "1; rm -rf /", since: NOW, hook: null }));
		expect(readListenerPid(paths)).toBeUndefined();

		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: 1.5, since: NOW, hook: null }));
		expect(readListenerPid(paths)).toBeUndefined();

		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: -5, since: NOW, hook: null }));
		expect(readListenerPid(paths)).toBeUndefined();

		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: 0, since: NOW, hook: null }));
		expect(readListenerPid(paths)).toBeUndefined();
	});

	it("accepts a real, alive pid", () => {
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null }));

		expect(readListenerPid(paths)?.pid).toBe(process.pid);
	});
});

describe("one listener at a time", () => {
	it("subscribes to an invite's relays as well as the saved ones", async () => {
		setUpNumber("ab".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		addInvite(db, {
			secret: "22".repeat(32),
			expiresAt: NOW + 10_000,
			asName: "dg",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ onSignal }));
		await ready;
		stop();
		await run;

		expect(pool.relaysUsed.some((relays) => relays.includes("wss://invite.example") && relays.includes("wss://saved.example"))).toBe(true);
	});

	it("a second phone __run leaves the first listener's claim and pid file alone", async () => {
		const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "phone", "__run"], { stdio: "ignore" });
		try {
			if (holder.pid === undefined) throw new Error("helper listener did not start");
			expect(isOurListener(holder.pid)).toBe(true);
			setUpNumber("ab".repeat(32));
			const { onSignal, ready, stop } = captureShutdown();
			const first = runListener(deps({ pid: holder.pid, onSignal }));
			await ready;
			const listenersBefore = pool.listeners.length;

			await runListener(deps({ pid: 4242 }));

			expect(pool.listeners).toHaveLength(listenersBefore);
			expect(readListenerPid(paths)?.pid).toBe(holder.pid);
			stop();
			await first;
		} finally {
			holder.kill();
		}
	});

	it("stops a listener that is missing an invite relay and starts exactly one replacement", () => {
		setUpNumber("ab".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		addInvite(db, {
			secret: "33".repeat(32),
			expiresAt: NOW + 10_000,
			asName: "dg",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null, relays: ["wss://saved.example"] }));
		let alive = true;
		const spawned: number[] = [];

		ensureListenerSubscribed(paths, db, {
			isOurListener: () => true,
			isAlive: () => alive,
			kill: () => {
				alive = false;
			},
			sleepSync: () => {},
			spawn: () => {
				spawned.push(1);
				return 777;
			},
			now: () => NOW,
			argvFor: (extra) => ["phone", "__run", ...extra],
		});

		expect(spawned).toEqual([1]);
		expect(JSON.parse(readFileSync(listenerPidPath(paths), "utf8"))).toMatchObject({
			pid: 777,
			relays: ["wss://saved.example", "wss://invite.example"],
		});
	});

	it("does not start a second listener when the running one will not exit", () => {
		setUpNumber("cd".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		addInvite(db, {
			secret: "44".repeat(32),
			expiresAt: NOW + 10_000,
			asName: "dg",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null, relays: ["wss://saved.example"] }));
		const spawned: number[] = [];

		expect(() =>
			ensureListenerSubscribed(paths, db, {
				isOurListener: () => true,
				isAlive: () => true,
				kill: () => {},
				sleepSync: () => {},
				spawn: () => {
					spawned.push(1);
					return 777;
				},
				now: () => NOW,
				argvFor: (extra) => ["phone", "__run", ...extra],
			}),
		).toThrow(`the phone listener (pid ${process.pid}) did not exit; no replacement was started`);

		expect(spawned).toEqual([]);
		expect(JSON.parse(readFileSync(listenerPidPath(paths), "utf8")).pid).toBe(process.pid);
	});

	it("restarts a systemd listener through the service instead of detaching a second one", () => {
		setUpNumber("ef".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		writeListener(db, { autostart: { kind: "systemd" } });
		addInvite(db, {
			secret: "55".repeat(32),
			expiresAt: NOW + 10_000,
			asName: "dg",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null, relays: ["wss://saved.example"] }));
		let alive = true;
		const restarted: string[] = [];
		const spawned: number[] = [];

		ensureListenerSubscribed(paths, db, {
			isOurListener: () => true,
			isAlive: () => alive,
			kill: () => {
				throw new Error("a managed listener is restarted by its service, not signaled here");
			},
			sleepSync: () => {},
			spawn: () => {
				spawned.push(1);
				return 777;
			},
			now: () => NOW,
			argvFor: (extra) => ["phone", "__run", ...extra],
			restartManaged: (kind) => {
				restarted.push(kind);
				alive = false;
			},
		});

		expect(restarted).toEqual(["systemd"]);
		expect(spawned).toEqual([]);
	});

	it("starts the command line captured before the stop when the replacement spawn fails", () => {
		setUpNumber("ab".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		addInvite(db, {
			secret: "66".repeat(32),
			expiresAt: NOW + 10_000,
			asName: "dg",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null, relays: ["wss://saved.example"] }));
		let alive = true;
		const spawned: string[][] = [];

		expect(() =>
			ensureListenerSubscribed(paths, db, {
				isOurListener: () => true,
				isAlive: () => alive,
				kill: () => {
					alive = false;
				},
				sleepSync: () => {},
				spawn: (argv) => {
					spawned.push(argv);
					if (spawned.length === 1) throw new Error("spawn failed");
					return 888;
				},
				now: () => NOW,
				argvFor: (extra) => ["phone", "__run", ...extra],
				commandArgs: () => ["/old/dg-agent", "phone", "__run"],
			}),
		).toThrow("the phone listener stopped and the replacement failed to start");

		expect(spawned).toEqual([
			["phone", "__run"],
			["/old/dg-agent", "phone", "__run"],
		]);
		expect(JSON.parse(readFileSync(listenerPidPath(paths), "utf8")).pid).toBe(888);
	});

	it("does not restart a listener whose pid file never recorded relays", () => {
		setUpNumber("cd".repeat(32));
		writeRelays(db, ["wss://saved.example"]);
		addInvite(db, {
			secret: "77".repeat(32),
			expiresAt: NOW + 10_000,
			asName: "dg",
			keyId: DEFAULT_NUMBER_KEY_ID,
			relays: ["wss://invite.example"],
		});
		writeFileSync(listenerPidPath(paths), JSON.stringify({ pid: process.pid, since: NOW, hook: null }));
		const spawned: number[] = [];

		ensureListenerSubscribed(paths, db, {
			isOurListener: () => true,
			isAlive: () => true,
			kill: () => {},
			sleepSync: () => {},
			spawn: () => {
				spawned.push(1);
				return 777;
			},
			now: () => NOW,
			argvFor: (extra) => ["phone", "__run", ...extra],
		});

		expect(spawned).toEqual([]);
	});
});

describe("claimListener", () => {
	function captureStderr(): { lines: string[]; restore: () => void } {
		const lines: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void) => {
			lines.push(String(chunk));
			if (typeof encoding === "function") encoding();
			else cb?.();
			return true;
		});
		return { lines, restore: () => spy.mockRestore() };
	}

	it("takes over a lock held by an unrelated live pid", () => {
		writeFileSync(listenerClaimPath(paths), `${process.pid}\n`, { mode: 0o600 });
		const stderr = captureStderr();
		try {
			expect(isOurListener(process.pid)).toBe(false);
			expect(claimListener(paths, 5150)).toBe(true);
			expect(readFileSync(listenerClaimPath(paths), "utf8").trim()).toBe("5150");
			expect(stderr.lines.join("")).toContain("taking over");
		} finally {
			stderr.restore();
		}
	});

	it("leaves a lock held by a phone listener and logs that the claim was lost", () => {
		writeFileSync(listenerClaimPath(paths), "4242\n", { mode: 0o600 });
		const stderr = captureStderr();
		try {
			expect(claimListener(paths, 5150, () => "ours")).toBe(false);
			expect(readFileSync(listenerClaimPath(paths), "utf8").trim()).toBe("4242");
			expect(stderr.lines.join("")).toContain("listener claim lost to 4242; pid 5150 is exiting");
		} finally {
			stderr.restore();
		}
	});

	it("treats a fresh empty lock as held, and takes over one old enough to be stale", () => {
		writeFileSync(listenerClaimPath(paths), "", { mode: 0o600 });
		expect(claimListener(paths, 5150)).toBe(false);
		expect(readFileSync(listenerClaimPath(paths), "utf8")).toBe("");

		const past = new Date(Date.now() - 5000);
		utimesSync(listenerClaimPath(paths), past, past);
		expect(claimListener(paths, 5150)).toBe(true);
		expect(readFileSync(listenerClaimPath(paths), "utf8").trim()).toBe("5150");
	});

	it("keeps a lock when the holder's command line cannot be read", () => {
		writeFileSync(listenerClaimPath(paths), "4242\n", { mode: 0o600 });
		const stderr = captureStderr();
		try {
			expect(claimListener(paths, 5150, () => "unknown")).toBe(false);
			expect(readFileSync(listenerClaimPath(paths), "utf8").trim()).toBe("4242");
			expect(stderr.lines.join("")).toContain("could not read the holder's command line; leaving its lock; pid 5150 is exiting");
		} finally {
			stderr.restore();
		}
	});

	it("names the error code when the lock file itself cannot be read, not the holder's command line", () => {
		mkdirSync(listenerClaimPath(paths));
		const past = new Date(Date.now() - 5000);
		utimesSync(listenerClaimPath(paths), past, past);
		const stderr = captureStderr();
		try {
			expect(claimListener(paths, 5150)).toBe(false);
			expect(stderr.lines.join("")).toContain("could not read the lock file (EISDIR); leaving its lock; pid 5150 is exiting");
		} finally {
			stderr.restore();
		}
	});

	it("falls back to an exclusive create when the filesystem cannot hard-link", () => {
		const link = () => {
			const err = new Error("operation not supported") as NodeJS.ErrnoException;
			err.code = "ENOTSUP";
			throw err;
		};

		expect(claimListener(paths, 5150, () => "foreign", link)).toBe(true);
		expect(readFileSync(listenerClaimPath(paths), "utf8").trim()).toBe("5150");
	});

	it("does not throw when linking fails and a phone listener already holds the lock", () => {
		writeFileSync(listenerClaimPath(paths), "4242\n", { mode: 0o600 });
		const link = () => {
			const err = new Error("operation not supported") as NodeJS.ErrnoException;
			err.code = "ENOTSUP";
			throw err;
		};
		const stderr = captureStderr();
		try {
			expect(claimListener(paths, 5150, () => "ours", link)).toBe(false);
			expect(readFileSync(listenerClaimPath(paths), "utf8").trim()).toBe("4242");
			expect(stderr.lines.join("")).toContain("listener claim lost to 4242; pid 5150 is exiting");
		} finally {
			stderr.restore();
		}
	});
});

describe("commandLookupFromText", () => {
	it("treats a failed or empty lookup as unknown and a real command line as args", () => {
		expect(commandLookupFromText(1, "")).toEqual({ kind: "unknown" });
		expect(commandLookupFromText(0, "")).toEqual({ kind: "unknown" });
		expect(commandLookupFromText(0, "   ")).toEqual({ kind: "unknown" });
		expect(commandLookupFromText(null, undefined)).toEqual({ kind: "unknown" });
		expect(commandLookupFromText(0, "C:\\dg\\dg-agent.exe phone __run")).toEqual({
			kind: "args",
			args: ["C:\\dg\\dg-agent.exe", "phone", "__run"],
		});
		expect(commandLookupFromText(0, "notepad.exe")).toEqual({ kind: "args", args: ["notepad.exe"] });
	});
});

describe("holderVerdict", () => {
	it("calls a dead pid foreign and does not throw when its command line is gone", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("helper did not start");
		await new Promise((resolve) => child.once("exit", resolve));

		expect(holderVerdict(pid)).toBe("foreign");
	});

	it("calls a zombie pid foreign instead of unknown, so its lock is not held forever", () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("helper did not start");
		try {
			blockingSleep(200);

			expect(holderVerdict(pid)).toBe("foreign");
		} finally {
			child.kill();
		}
	});
});

describe("displaceStaleLock", () => {
	it("deletes a stale lock only when the renamed bytes are the ones that were judged stale", () => {
		const path = listenerClaimPath(paths);
		writeFileSync(path, "111\n", { mode: 0o600 });

		expect(displaceStaleLock(path, "111\n", `${path}.aside`)).toBe("displaced");
		expect(existsSync(path)).toBe(false);
		expect(existsSync(`${path}.aside`)).toBe(false);
	});

	it("puts the lock back when the renamed file is no longer the stale bytes", () => {
		const path = listenerClaimPath(paths);
		writeFileSync(path, "222\n", { mode: 0o600 });

		expect(displaceStaleLock(path, "111\n", `${path}.aside`)).toBe("restored");
		expect(readFileSync(path, "utf8")).toBe("222\n");
		expect(existsSync(`${path}.aside`)).toBe(false);
	});

	it("falls back to a rename when the filesystem cannot hard-link, so the put-back still restores a live lock", () => {
		const path = listenerClaimPath(paths);
		writeFileSync(path, "222\n", { mode: 0o600 });
		const link = () => {
			const err = new Error("operation not supported") as NodeJS.ErrnoException;
			err.code = "ENOTSUP";
			throw err;
		};

		expect(displaceStaleLock(path, "111\n", `${path}.aside`, link)).toBe("restored");
		expect(readFileSync(path, "utf8")).toBe("222\n");
		expect(existsSync(`${path}.aside`)).toBe(false);
	});

	it("does not overwrite a third contender's fresh lock, and still cleans up the aside file, when the put-back lands on an occupied path", () => {
		const path = listenerClaimPath(paths);
		const aside = `${path}.aside`;
		writeFileSync(path, "222\n", { mode: 0o600 });

		const grandchildScript = `
import { mock } from "bun:test";
const fs = await import("node:fs");
const originalLink = fs.linkSync;
let injected = false;
mock.module("node:fs", () => ({
	...fs,
	linkSync(src, dest) {
		if (!injected && dest === ${JSON.stringify(path)}) {
			injected = true;
			fs.writeFileSync(dest, "999\\n", { mode: 0o600 });
		}
		return originalLink(src, dest);
	},
}));
const { displaceStaleLock } = await import(${JSON.stringify(`${import.meta.dir}/../../src/phone/listener.ts`)});
const result = displaceStaleLock(${JSON.stringify(path)}, "111\\n", ${JSON.stringify(aside)});
console.log(JSON.stringify({ injected, result }));
`;
		const proc = Bun.spawnSync([process.execPath, "--eval", grandchildScript], { stdio: ["ignore", "pipe", "pipe"] });

		expect(proc.stderr.toString()).toBe("");
		expect(proc.exitCode).toBe(0);
		const outcome = JSON.parse(proc.stdout.toString());
		expect(outcome.injected).toBe(true);
		expect(outcome.result).toBe("restored");
		expect(readFileSync(path, "utf8")).toBe("999\n");
		expect(existsSync(aside)).toBe(false);
	});
});
