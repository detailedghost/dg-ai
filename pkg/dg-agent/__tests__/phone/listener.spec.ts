import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { publish, ring, wrap } from "../../src/phone/chat";
import { PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { createFileKey, ensureKey, type KeyClient } from "../../src/phone/keys";
import { isListenerArgs, listenerPidPath, type ListenerDeps, runListener } from "../../src/phone/listener";
import type { CommandPushTarget } from "../../src/phone/push";
import {
	addContact,
	addInvite,
	DEFAULT_NUMBER_KEY_ID,
	findContactByHandle,
	findContactByNpub,
	listContacts,
	numberKeyId,
	writeNumber,
} from "../../src/phone/store";
import { createFakePool, type FakePool } from "./fake-pool";

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
		expect(payload).toMatchObject({ from: caller.npub, handle: "grok", text: "hello there", call: true });
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
		setUpNumber("55".repeat(32));
		const hook: CommandPushTarget = { kind: "command", argv: ["notify-send"], timeoutMs: 7000 };
		const { onSignal, ready, stop } = captureShutdown();

		const run = runListener(deps({ hook, onSignal, pid: 9999 }));
		await ready;

		const written = JSON.parse(readFileSync(listenerPidPath(paths), "utf8"));
		expect(written).toEqual({ pid: 9999, since: NOW, hook: { argv: ["notify-send"], timeoutS: 7 } });

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
});

describe("isListenerArgs", () => {
	it("matches the current and the old listener's argv, and nothing else", () => {
		expect(isListenerArgs(["dg-agent", "phone", "__run"])).toBe(true);
		expect(isListenerArgs(["dg-agent", "phone-friend", "__run"])).toBe(true);
		expect(isListenerArgs(["dg-agent", "phone", "number"])).toBe(false);
	});
});
