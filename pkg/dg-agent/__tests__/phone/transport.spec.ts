import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19, nip59 } from "nostr-tools";
import { type ControlRumor, FILE_REQUEST_KIND } from "../../src/phone/chat";
import { OUTBOX_DIR, PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { createFileKey, type KeyClient } from "../../src/phone/keys";
import { type ListenerDeps, runListener } from "../../src/phone/listener";
import { addContact, numberKeyId } from "../../src/phone/store";
import { createFileRequestHandler, DAILY_REQUEST_CAP, requestFile, SEEN_LIMIT } from "../../src/phone/transport";
import { type WormholeDeps, wormholeCode } from "../../src/phone/wormhole";
import { createFakePool, type FakePool } from "./fake-pool";
import { fakeWormhole, type FakeWormhole } from "./fake-wormhole";

const RELAYS = ["wss://a.example"];
let root: string;
let senderHome: string;
let senderPaths: DgPaths;
let senderDb: PhoneDb;
let senderSk: Uint8Array;
let senderPub: string;
let receiverSk: Uint8Array;
let receiverPub: string;
let pool: FakePool;
let NOW: number;
const cipher = randomBytes(4000);
const x = createHash("sha256").update(cipher).digest("hex");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await Bun.sleep(10);
	}
}

function stageOutbox(hash: string, bytes: Buffer, recipients: string[] = [receiverPub], keyId = numberKeyId(senderDb)): void {
	const dir = join(senderPaths.phoneRoot, OUTBOX_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, hash), bytes, { mode: 0o600 });
	senderDb.addOutbox(hash, keyId, recipients);
}

function request(overrides: Partial<ControlRumor> & { x?: string; code?: string } = {}): ControlRumor {
	const { x: hash = x, code = wormholeCode(), ...rest } = overrides;
	return {
		id: randomBytes(32).toString("hex"),
		wrapId: randomBytes(32).toString("hex"),
		kind: FILE_REQUEST_KIND,
		from: receiverPub,
		keyId: numberKeyId(senderDb),
		createdAt: NOW,
		tags: [
			["p", senderPub],
			["x", hash],
			["code", code],
		],
		...rest,
	};
}

function sends(fake: FakeWormhole): string[][] {
	return fake.runs().filter((run) => run.args[0] === "send").map((run) => run.args);
}

function stalledDownload(fake: FakeWormhole): { deps: WormholeDeps; started: () => boolean } {
	let started = false;
	const fetch = (_url: string, init: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			started = true;
			init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	return { deps: { ...fake.deps, fetch }, started: () => started };
}

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | "still running"> {
	return Promise.race([work, Bun.sleep(ms).then(() => "still running" as const)]);
}

beforeEach(() => {
	NOW = Math.floor(Date.now() / 1000);
	root = mkdtempSync(join(tmpdir(), "dg-phone-transport-"));
	senderHome = join(root, "sender");
	senderPaths = resolveDgPaths({ env: { DG_HOME: senderHome } });
	senderDb = PhoneDb.open(senderPaths, () => NOW);
	senderSk = createFileKey(senderDb, numberKeyId(senderDb)) as Uint8Array;
	senderPub = getPublicKey(senderSk);
	receiverSk = generateSecretKey();
	receiverPub = getPublicKey(receiverSk);
	addContact(senderDb, {
		npub: nip19.npubEncode(receiverPub),
		handle: "bob",
		relays: RELAYS,
		keyId: numberKeyId(senderDb),
		addedAt: NOW,
		via: "number",
	});
	pool = createFakePool();
	stageOutbox(x, cipher);
});

afterEach(() => {
	senderDb.close();
	rmSync(root, { recursive: true, force: true });
});

describe("createFileRequestHandler", () => {
	function handler(fake: FakeWormhole) {
		return createFileRequestHandler({ db: senderDb, paths: senderPaths, now: () => NOW, wormhole: fake.deps });
	}

	it("sends the outbox file to a recipient that asks with a fresh code", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		const code = wormholeCode();
		files.handle(request({ code }));
		await files.settle();
		expect(sends(fake)).toEqual([["send", "--code", code, "--hide-progress", join(senderPaths.phoneRoot, OUTBOX_DIR, x)]]);
	});

	it("drops a request whose x is not 64 lowercase hex", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		files.handle(request({ x: x.toUpperCase() }));
		files.handle(request({ x: `${x.slice(0, 63)}/` }));
		files.handle(request({ x: "../phone.db" }));
		const upper = "A".repeat(64);
		stageOutbox(upper, Buffer.from("upper"));
		files.handle(request({ x: upper }));
		await files.settle();
		expect(sends(fake)).toEqual([]);
	});

	it("drops a requester that is not an allowed recipient of x, silently", async () => {
		const fake = fakeWormhole(root);
		const other = generateSecretKey();
		const otherPub = getPublicKey(other);
		addContact(senderDb, { npub: nip19.npubEncode(otherPub), handle: "eve", relays: RELAYS, keyId: numberKeyId(senderDb), addedAt: NOW, via: "number" });
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const files = handler(fake);
			files.handle(request({ from: otherPub }));
			await files.settle();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
		expect(sends(fake)).toEqual([]);
	});

	it("drops an allowed recipient that is no longer a contact", async () => {
		const fake = fakeWormhole(root);
		const stranger = getPublicKey(generateSecretKey());
		const strangerX = createHash("sha256").update("stranger").digest("hex");
		stageOutbox(strangerX, Buffer.from("stranger"), [stranger]);
		const files = handler(fake);
		files.handle(request({ from: stranger, x: strangerX }));
		await files.settle();
		expect(sends(fake)).toEqual([]);
	});

	it("drops an unknown x silently", async () => {
		const fake = fakeWormhole(root);
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const files = handler(fake);
			files.handle(request({ x: "f".repeat(64) }));
			await files.settle();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
		expect(sends(fake)).toEqual([]);
	});

	it("drops a request that arrived on a key other than the one that sent x", async () => {
		const fake = fakeWormhole(root);
		createFileKey(senderDb, "other-key");
		const files = handler(fake);
		files.handle(request({ keyId: "other-key" }));
		await files.settle();
		expect(sends(fake)).toEqual([]);
	});

	it("drops a request when the outbox entry is a symlink", async () => {
		const fake = fakeWormhole(root);
		const linked = createHash("sha256").update("linked").digest("hex");
		const outside = join(root, "outside");
		writeFileSync(outside, "secret");
		symlinkSync(outside, join(senderPaths.phoneRoot, OUTBOX_DIR, linked));
		senderDb.addOutbox(linked, numberKeyId(senderDb), [receiverPub]);
		const files = handler(fake);
		files.handle(request({ x: linked }));
		await files.settle();
		expect(sends(fake)).toEqual([]);
	});

	it("drops a code outside the wormhole code format", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		for (const code of ["7-crossover-clockwork", `12345678-${"a".repeat(19)}`, `x-${"a".repeat(26)}`, `12345678-${"a".repeat(26)} --text`]) {
			files.handle(request({ code }));
		}
		files.handle({ ...request(), tags: [["p", senderPub], ["x", x]] });
		await files.settle();
		expect(sends(fake)).toEqual([]);
	});

	it("drops a request more than 5 minutes stale or in the future", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		files.handle(request({ createdAt: NOW - 301 }));
		files.handle(request({ createdAt: NOW + 301 }));
		await files.settle();
		expect(sends(fake)).toEqual([]);
		files.handle(request({ createdAt: NOW - 299 }));
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
	});

	it("handles a rumor id once", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		const first = request();
		files.handle(first);
		await files.settle();
		files.handle({ ...first, tags: [["p", senderPub], ["x", x], ["code", wormholeCode()]] });
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
	});

	it("never sends twice on one code", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		const code = wormholeCode();
		files.handle(request({ code }));
		await files.settle();
		files.handle(request({ code }));
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
	});

	it("does not spend a code on a request refused before authorization", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		const code = wormholeCode();
		files.handle(request({ code, x: "f".repeat(64) }));
		await files.settle();
		files.handle(request({ code }));
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
	});

	it("does not spend a rumor id on a request refused by the rate checks", async () => {
		const fake = fakeWormhole(root, { send: "hang", limits: { sendMs: 300 } });
		const files = handler(fake);
		files.handle(request());
		const refused = request();
		files.handle(refused);
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
		files.handle(refused);
		await files.settle();
		expect(sends(fake)).toHaveLength(2);
	});

	it("evicts the oldest remembered request once the replay cache is full", async () => {
		const fake = fakeWormhole(root);
		const requesters = Array.from({ length: Math.ceil(SEEN_LIMIT / 2 / DAILY_REQUEST_CAP) + 1 }, (_, index) => {
			const pub = getPublicKey(generateSecretKey());
			addContact(senderDb, { npub: nip19.npubEncode(pub), handle: `r${index}`, relays: RELAYS, keyId: numberKeyId(senderDb), addedAt: NOW, via: "number" });
			return pub;
		});
		stageOutbox(x, cipher, [receiverPub, ...requesters]);
		const files = handler(fake);
		const first = request();
		files.handle(first);
		await files.settle();
		files.handle(first);
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
		for (let index = 0; index < SEEN_LIMIT / 2; index += 1) {
			files.handle(request({ from: requesters[Math.floor(index / DAILY_REQUEST_CAP)] }));
			await files.settle();
		}
		files.handle(first);
		await files.settle();
		expect(sends(fake)).toHaveLength(SEEN_LIMIT / 2 + 2);
	});

	it("keeps one open request per requester and x", async () => {
		const fake = fakeWormhole(root, { send: "hang", limits: { sendMs: 400 } });
		const files = handler(fake);
		files.handle(request());
		files.handle(request());
		await files.settle();
		expect(sends(fake)).toHaveLength(1);
		files.handle(request());
		await files.settle();
		expect(sends(fake)).toHaveLength(2);
	});

	it("runs one send at a time and drops requests past a queue of 4", async () => {
		const fake = fakeWormhole(root, { send: "hang", limits: { sendMs: 300 } });
		const hashes = Array.from({ length: 6 }, (_, index) => {
			const bytes = Buffer.from(`blob-${index}`);
			const hash = createHash("sha256").update(bytes).digest("hex");
			stageOutbox(hash, bytes);
			return hash;
		});
		const files = handler(fake);
		for (const hash of hashes) files.handle(request({ x: hash }));
		await waitUntil(() => fake.runs().length === 1);
		await Bun.sleep(100);
		expect(fake.runs()).toHaveLength(1);
		await files.settle();
		expect(sends(fake).map((args) => args[4]?.slice(-64))).toEqual(hashes.slice(0, 5));
	});

	it("caps requests per contact per day", async () => {
		const fake = fakeWormhole(root);
		const files = handler(fake);
		for (let index = 0; index < 21; index += 1) {
			files.handle(request());
			await files.settle();
		}
		expect(sends(fake)).toHaveLength(20);
	});

	it("kills the send process tree at the deadline", async () => {
		const fake = fakeWormhole(root, { send: "hang", limits: { sendMs: 300 } });
		const files = handler(fake);
		files.handle(request());
		await files.settle();
		expect(alive(fake.runs()[0]?.pid ?? 0)).toBe(false);
	});

	it("kills a running send on stop", async () => {
		const fake = fakeWormhole(root, { send: "hang", limits: { sendMs: 60_000 } });
		const files = handler(fake);
		files.handle(request());
		await waitUntil(() => fake.runs().length === 1);
		files.stop();
		await files.settle();
		expect(alive(fake.runs()[0]?.pid ?? 0)).toBe(false);
	});

	it("settles a stop that lands during the first-use download, and never spawns send", async () => {
		const fake = fakeWormhole(root);
		const stalled = stalledDownload(fake);
		const files = createFileRequestHandler({ db: senderDb, paths: senderPaths, now: () => NOW, wormhole: stalled.deps });
		files.handle(request());
		await waitUntil(stalled.started);
		files.stop();
		expect(await settlesWithin(files.settle(), 2000)).toBeUndefined();
		expect(fake.runs()).toEqual([]);
	});

	it("spawns send with a minimal env", async () => {
		process.env.DG_GRANT_TOKEN_TEST = "leak";
		try {
			const fake = fakeWormhole(root);
			const files = handler(fake);
			files.handle(request());
			await files.settle();
			expect(fake.runs()[0]?.env).toEqual({});
		} finally {
			delete process.env.DG_GRANT_TOKEN_TEST;
		}
	});
});

describe("requestFile", () => {
	function receiverKey() {
		return { id: "r1", pub: receiverPub, sk: receiverSk };
	}

	function receiverPaths(): DgPaths {
		return resolveDgPaths({ env: { DG_HOME: join(root, "receiver") } });
	}

	it("wraps a file request rumor to the sender with x and a fresh code", async () => {
		const fake = fakeWormhole(root, { receive: "hang", limits: { receiveMs: 200 } });
		await requestFile({ x, size: cipher.length, senderPub, key: receiverKey(), relays: RELAYS }, { pool, paths: receiverPaths(), wormhole: fake.deps });
		await requestFile({ x, size: cipher.length, senderPub, key: receiverKey(), relays: RELAYS }, { pool, paths: receiverPaths(), wormhole: fake.deps });
		expect(pool.events).toHaveLength(2);
		const rumors = pool.events.map((event) => nip59.unwrapEvent(event, senderSk));
		const codes = rumors.map((rumor) => rumor.tags.find((tag) => tag[0] === "code")?.[1]);
		for (const rumor of rumors) {
			expect(rumor.kind).toBe(FILE_REQUEST_KIND);
			expect(rumor.pubkey).toBe(receiverPub);
			expect(rumor.content).toBe("");
			expect(rumor.tags.find((tag) => tag[0] === "x")?.[1]).toBe(x);
			expect(rumor.tags.find((tag) => tag[0] === "p")?.[1]).toBe(senderPub);
		}
		expect(codes[0]).not.toBe(codes[1]);
		for (const run of fake.runs()) for (const code of codes) expect(JSON.stringify(run.args)).not.toContain(code ?? "");
	});

	it("reports request not sent and runs no receive when every relay refuses", async () => {
		const fake = fakeWormhole(root);
		const refusing = createFakePool([]);
		const result = await requestFile(
			{ x, size: cipher.length, senderPub, key: receiverKey(), relays: RELAYS },
			{ pool: refusing, paths: receiverPaths(), wormhole: fake.deps },
		);
		expect(result).toEqual({ ok: false, reason: "request not sent" });
		expect(fake.runs()).toEqual([]);
	});

	it("returns on abort during the first-use download, and publishes no request and spawns nothing", async () => {
		const fake = fakeWormhole(root);
		const stalled = stalledDownload(fake);
		const controller = new AbortController();
		const fetching = requestFile(
			{ x, size: cipher.length, senderPub, key: receiverKey(), relays: RELAYS },
			{ pool, paths: receiverPaths(), wormhole: stalled.deps, signal: controller.signal },
		);
		await waitUntil(stalled.started);
		controller.abort();
		expect(await settlesWithin(fetching, 2000)).toEqual({ ok: false, reason: "timeout" });
		expect(pool.events).toEqual([]);
		expect(fake.runs()).toEqual([]);
	});

	it("publishes no request when the signal is already aborted", async () => {
		const fake = fakeWormhole(root);
		const controller = new AbortController();
		controller.abort();
		const result = await requestFile(
			{ x, size: cipher.length, senderPub, key: receiverKey(), relays: RELAYS },
			{ pool, paths: receiverPaths(), wormhole: fake.deps, signal: controller.signal },
		);
		expect(result).toEqual({ ok: false, reason: "timeout" });
		expect(pool.events).toEqual([]);
		expect(fake.runs()).toEqual([]);
	});

	it("refuses a bad x or an oversized size tag before any request", async () => {
		const fake = fakeWormhole(root);
		const target = { size: cipher.length, senderPub, key: receiverKey(), relays: RELAYS };
		const deps = { pool, paths: receiverPaths(), wormhole: fake.deps };
		expect(await requestFile({ ...target, x: "../x" }, deps)).toEqual({ ok: false, reason: "bad offer" });
		expect(await requestFile({ ...target, x, size: 5 * 1024 * 1024 + 17 }, deps)).toEqual({ ok: false, reason: "too large" });
		expect(pool.events).toEqual([]);
	});
});

describe("listener file requests", () => {
	function noopSchedule(): Schedule {
		return () => () => {};
	}

	function listenerDeps(fake: FakeWormhole, onSignal: ListenerDeps["onSignal"]): ListenerDeps {
		return {
			paths: senderPaths,
			db: senderDb,
			sessionClient: async () => undefined,
			grantClient: (): KeyClient => {
				throw new Error("no grant in file-mode tests");
			},
			createPool: () => ({ ...pool, close: () => {} }),
			now: () => NOW,
			pid: 4343,
			schedule: noopSchedule(),
			onSignal,
			wormhole: fake.deps,
		};
	}

	function startListener(fake: FakeWormhole) {
		let stop: () => void = () => {};
		let ready: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const done = runListener(
			listenerDeps(fake, (signal, handler) => {
				if (signal !== "SIGTERM") return;
				stop = handler;
				ready();
			}),
		);
		return { started, stop: () => stop(), done };
	}

	it("delivers the outbox file to the receiver through a live request", async () => {
		const rendezvous = join(root, "shared-rendezvous");
		const senderFake = fakeWormhole(join(root), { rendezvous });
		const receiverFake = fakeWormhole(join(root), { rendezvous });
		const listener = startListener(senderFake);
		await listener.started;
		try {
			const result = await requestFile(
				{ x, size: cipher.length, senderPub, key: { id: "r1", pub: receiverPub, sk: receiverSk }, relays: RELAYS },
				{ pool, paths: resolveDgPaths({ env: { DG_HOME: join(root, "receiver") } }), wormhole: receiverFake.deps },
			);
			expect(result).toEqual({ ok: true, cipher });
		} finally {
			listener.stop();
			await listener.done;
		}
	});

	it("ignores a request rumor from a stranger and logs nothing about it", async () => {
		const senderFake = fakeWormhole(root);
		const stranger = generateSecretKey();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		const listener = startListener(senderFake);
		await listener.started;
		try {
			const event = nip59.wrapEvent(
				{ kind: FILE_REQUEST_KIND, content: "", tags: [["p", senderPub], ["x", x], ["code", wormholeCode()]] },
				stranger,
				senderPub,
			);
			await pool.publish(RELAYS, event)[0];
			await Bun.sleep(200);
			expect(senderFake.runs()).toEqual([]);
			const lines = stderr.mock.calls.map((call) => String(call[0])).filter((line) => !line.includes("not addressed to a loaded key"));
			expect(lines.join("")).not.toContain("dropped");
		} finally {
			listener.stop();
			await listener.done;
			stderr.mockRestore();
		}
	});

	it("kills a running send when the listener stops", async () => {
		const senderFake = fakeWormhole(root, { send: "hang", limits: { sendMs: 60_000 } });
		const listener = startListener(senderFake);
		await listener.started;
		const event = nip59.wrapEvent(
			{ kind: FILE_REQUEST_KIND, content: "", tags: [["p", senderPub], ["x", x], ["code", wormholeCode()]] },
			receiverSk,
			senderPub,
		);
		await pool.publish(RELAYS, event)[0];
		await waitUntil(() => senderFake.runs().length === 1);
		listener.stop();
		await listener.done;
		await waitUntil(() => !alive(senderFake.runs()[0]?.pid ?? 0), 3000);
	});
});
