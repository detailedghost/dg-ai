import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { nip59 } from "nostr-tools";
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
import { PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { readFileKey, type KeyClient } from "../../src/phone/keys";
import { runListener, type ListenerDeps } from "../../src/phone/listener";
import { addContact, numberKeyId } from "../../src/phone/store";
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
		await expect(phoneSay("#room", "nope", refusedDeps)).rejects.toThrow(/behind: \+b/);
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
