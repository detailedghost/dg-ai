import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { getPublicKey, nip59, type NostrEvent } from "nostr-tools";
import { FILE_REQUEST_KIND, npubOf, wrapTagged } from "../../src/phone/chat";
import { phoneFiles, phoneInbox, phoneNumber, phoneSay, phoneThreadNew, phoneVoicemail, type PhoneDeps } from "../../src/phone/commands";
import { type ImageFetchRow, MESSAGE_TTL_SECONDS, OUTBOX_DIR, PHI_TTL_SECONDS, PhoneDb } from "../../src/phone/db";
import type { Schedule } from "../../src/phone/hook";
import { FILES_DIR, prepareImage, WORMHOLE_SCHEME } from "../../src/phone/image";
import { readFileKey, type KeyClient } from "../../src/phone/keys";
import { type ListenerDeps, runListener, STUCK_RETRY_INTERVAL_MS } from "../../src/phone/listener";
import { createImageReceiver, FILES_BYTE_CAP, IMAGE_RETRY_BASE_SECONDS, MAX_PENDING_IMAGES } from "../../src/phone/receive";
import { addContact, numberKeyId, writeFilesOn } from "../../src/phone/store";
import { DAILY_REQUEST_CAP } from "../../src/phone/transport";
import { createFakePool, type FakePool, makeHomeTracker, parseNdjson } from "./fake-pool";
import { createFakeCredentials, type FakeCredentials } from "./fake-vault";
import { keyPeriod, openVaultItem, VAULT_DIR, VAULT_TTL_SECONDS, vaultKeyName } from "../../src/phone/vault";
import { pngOfSize } from "./fake-image";
import { fakeWormhole, type FakeWormhole } from "./fake-wormhole";

const RELAYS = ["wss://a.example"];
const tracker = makeHomeTracker("dg-phone-receive-");
let clock: number;
let pool: FakePool;
let shared: string;

type Phone = { deps: PhoneDeps; npub: string; pub: string; sk: Uint8Array };

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await Bun.sleep(10);
	}
}

async function boot(name: string): Promise<Phone> {
	const home = tracker.freshHome();
	const paths = resolveDgPaths({ env: { DG_HOME: home } });
	const db = PhoneDb.open(paths, () => clock);
	tracker.trackDb(db);
	const deps: PhoneDeps = {
		paths,
		db,
		createPool: () => ({ ...pool, close() {} }),
		write: () => {},
		readStdin: async () => undefined,
		now: () => clock,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
	};
	await phoneNumber({ as: name, relay: RELAYS }, deps);
	const sk = readFileKey(db, numberKeyId(db));
	if (!sk) throw new Error("missing number key");
	return { deps, npub: npubOf(sk), pub: getPublicKey(sk), sk };
}

function link(left: Phone, leftHandle: string, right: Phone, rightHandle: string): void {
	addContact(left.deps.db, { npub: right.npub, handle: leftHandle, relays: RELAYS, keyId: numberKeyId(left.deps.db), addedAt: clock, via: "accept" });
	addContact(right.deps.db, { npub: left.npub, handle: rightHandle, relays: RELAYS, keyId: numberKeyId(right.deps.db), addedAt: clock, via: "accept" });
}

function wormholeFor(opts: Parameters<typeof fakeWormhole>[1] = {}): FakeWormhole {
	return fakeWormhole(shared, { rendezvous: join(shared, "rendezvous"), ...opts });
}

type Timer = { delayMs: number; run: () => void };

function capturingSchedule(): { schedule: Schedule; timers: Timer[] } {
	const timers: Timer[] = [];
	const schedule: Schedule = (delayMs, run) => {
		const timer = { delayMs, run };
		timers.push(timer);
		return () => {
			const at = timers.indexOf(timer);
			if (at >= 0) timers.splice(at, 1);
		};
	};
	return { schedule, timers };
}

function listen(
	phone: Phone,
	wormhole: FakeWormhole,
	opts: { schedule?: Schedule; hook?: ListenerDeps["hook"]; vaultClient?: ListenerDeps["vaultClient"] } = {},
) {
	let stop: () => void = () => {};
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const run = runListener({
		paths: phone.deps.paths,
		db: phone.deps.db,
		sessionClient: phone.deps.sessionClient,
		grantClient: phone.deps.grantClient,
		createPool: () => ({ ...pool, close() {} }),
		now: () => clock,
		pid: 7000 + Math.floor(Math.random() * 1000),
		schedule: opts.schedule ?? ((() => () => {}) as Schedule),
		onSignal: (signal, handler) => {
			if (signal !== "SIGTERM") return;
			stop = handler;
			ready();
		},
		wormhole: wormhole.deps,
		...(opts.hook ? { hook: opts.hook } : {}),
		...(opts.vaultClient ? { vaultClient: opts.vaultClient } : {}),
	});
	return {
		started,
		stop: async () => {
			stop();
			await run;
		},
	};
}

function row(phone: Phone, id: string) {
	return phone.deps.db.recentMessages(500).find((candidate) => candidate.id === id);
}

async function settled(phone: Phone, id: string) {
	await waitUntil(() => {
		const found = row(phone, id);
		return found !== undefined && found.text !== "[image pending]";
	});
	return row(phone, id);
}

function filesIn(phone: Phone): string[] {
	const dir = join(phone.deps.paths.phoneRoot, FILES_DIR);
	return existsSync(dir) ? readdirSync(dir) : [];
}

function seal(plain: Buffer, key = randomBytes(32)) {
	const nonce = randomBytes(12);
	const cipherer = createCipheriv("aes-256-gcm", key, nonce);
	const cipher = Buffer.concat([cipherer.update(plain), cipherer.final(), cipherer.getAuthTag()]);
	return { cipher, key: key.toString("hex"), nonce: nonce.toString("hex"), x: sha256(cipher), ox: sha256(plain) };
}

function stageAt(sender: Phone, cipher: Buffer, to: Phone): void {
	const dir = join(sender.deps.paths.phoneRoot, OUTBOX_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, sha256(cipher)), cipher, { mode: 0o600 });
	sender.deps.db.addOutbox(sha256(cipher), numberKeyId(sender.deps.db), [to.pub]);
}

function offerEvent(
	from: Phone,
	to: Phone,
	sealed: ReturnType<typeof seal>,
	overrides: Record<string, string> = {},
	extra: string[][] = [],
): NostrEvent {
	const values: Record<string, string> = {
		"file-type": "image/png",
		"encryption-algorithm": "aes-gcm",
		"decryption-key": sealed.key,
		"decryption-nonce": sealed.nonce,
		x: sealed.x,
		ox: sealed.ox,
		size: String(sealed.cipher.length),
		...overrides,
	};
	return wrapTagged(
		{ kind: 15, content: `${WORMHOLE_SCHEME}${sealed.x}`, tags: [...Object.entries(values), ...extra] },
		from.sk,
		to.pub,
	);
}

async function deliver(event: NostrEvent): Promise<void> {
	await Promise.all(pool.publish(RELAYS, event));
}

function requestsTo(sender: Phone): NostrEvent[] {
	return pool.events.filter((event) => {
		if (!event.tags.some((tag) => tag[0] === "p" && tag[1] === sender.pub)) return false;
		try {
			return nip59.unwrapEvent(event, sender.sk).kind === FILE_REQUEST_KIND;
		} catch {
			return false;
		}
	});
}

beforeEach(() => {
	clock = Math.floor(Date.now() / 1000);
	pool = createFakePool();
	shared = tracker.freshHome();
});

afterEach(() => {
	tracker.cleanup();
});

describe("image receive acceptance", () => {
	it("stores a PNG sent to a contact and to a #thread, with the stripped hash in voicemail", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		link(alice, "b", bob, "a");
		phoneFiles("on", alice.deps);
		phoneFiles("on", bob.deps);
		const source = pngOfSize(3, 2);
		const imagePath = join(shared, "shot.png");
		writeFileSync(imagePath, source);
		const stripped = prepareImage(source).file.sha256;
		expect(stripped).not.toBe(sha256(source));
		const aliceListener = listen(alice, wormholeFor());
		const bobListener = listen(bob, wormholeFor());
		await Promise.all([aliceListener.started, bobListener.started]);
		try {
			await phoneSay("+b", undefined, alice.deps, { image: imagePath });
			await phoneThreadNew("#ops", ["+b"], { subject: "ops" }, alice.deps);
			await phoneSay("#ops", undefined, alice.deps, { image: imagePath });
			await waitUntil(() => bob.deps.db.recentMessages(10).filter((candidate) => candidate.text === "[image]").length === 2);

			const printed: string[] = [];
			bob.deps.write = (text) => printed.push(text);
			await phoneVoicemail(bob.deps);
			const images = (parseNdjson(printed) as { text: string; thread?: string; file?: { path: string; sha256: string; untrusted: boolean } }[]).filter(
				(entry) => entry.file,
			);

			expect(images).toHaveLength(2);
			expect(images.map((entry) => entry.thread ?? null).sort()).toEqual(["#ops", null].sort());
			for (const entry of images) {
				expect(entry.text).toBe("[image]");
				expect(entry.file?.sha256).toBe(stripped);
				expect(entry.file?.untrusted).toBe(true);
				expect(entry.file?.path).toBe(join(bob.deps.paths.phoneRoot, FILES_DIR, `${stripped}.png`));
				expect(sha256(readFileSync(entry.file?.path ?? ""))).toBe(stripped);
			}
			if (process.platform !== "win32") {
				expect(statSync(join(bob.deps.paths.phoneRoot, FILES_DIR)).mode & 0o777).toBe(0o700);
				expect(statSync(images[0]?.file?.path ?? "").mode & 0o777).toBe(0o600);
			}
			expect(bob.deps.db.imageFetches()).toEqual([]);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}
	});
});

describe("image receive contracts", () => {
	let alice: Phone;
	let bob: Phone;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
		writeFilesOn(bob.deps.db, true);
	});

	async function receiveOne(event: NostrEvent, bobWormhole: FakeWormhole = wormholeFor()) {
		const aliceListener = listen(alice, wormholeFor());
		const bobListener = listen(bob, bobWormhole);
		await Promise.all([aliceListener.started, bobListener.started]);
		try {
			await deliver(event);
			return await settled(bob, event.id);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}
	}

	it("names the file from the computed hash and ignores a hostile file-type", async () => {
		const sealed = seal(pngOfSize());
		stageAt(alice, sealed.cipher, bob);

		const stored = await receiveOne(offerEvent(alice, bob, sealed, { "file-type": "../../x" }));

		expect(stored?.text).toBe("[image]");
		expect(filesIn(bob)).toEqual([`${sealed.ox}.png`]);
	});

	it("stores files are off, and makes no fetch, when the receiver has files off", async () => {
		writeFilesOn(bob.deps.db, false);
		const sealed = seal(pngOfSize());
		stageAt(alice, sealed.cipher, bob);
		const wormhole = wormholeFor();

		const stored = await receiveOne(offerEvent(alice, bob, sealed), wormhole);

		expect(stored?.text).toBe("[image unavailable: files are off]");
		expect(wormhole.runs()).toEqual([]);
		expect(requestsTo(alice)).toEqual([]);
	});

	const failures: { reason: string; build: () => { sealed: ReturnType<typeof seal>; overrides?: Record<string, string> } }[] = [
		{ reason: "hash mismatch", build: () => ({ sealed: seal(pngOfSize()), overrides: { ox: "0".repeat(64) } }) },
		{
			reason: "decrypt failed",
			build: () => {
				const sealed = seal(pngOfSize());
				return { sealed, overrides: { "decryption-key": randomBytes(32).toString("hex") } };
			},
		},
		{ reason: "not an image", build: () => ({ sealed: seal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) }) },
		{ reason: "too large", build: () => ({ sealed: seal(pngOfSize(8000, 6000)) }) },
	];

	for (const failure of failures) {
		it(`stores ${failure.reason} as the placeholder and writes no file`, async () => {
			const { sealed, overrides } = failure.build();
			stageAt(alice, sealed.cipher, bob);
			const event = offerEvent(alice, bob, sealed, overrides);

			const stored = await receiveOne(event);

			expect(stored?.text).toBe(`[image unavailable: ${failure.reason}]`);
			expect(stored?.file).toBeNull();
			expect(filesIn(bob)).toEqual([]);
			expect(bob.deps.db.imageFetches()).toEqual([]);
		});
	}

	it("stores fetch failed when the received transfer is not exactly one file named x", async () => {
		const sealed = seal(pngOfSize());
		stageAt(alice, sealed.cipher, bob);

		const stored = await receiveOne(offerEvent(alice, bob, sealed), wormholeFor({ receive: "two-files" }));

		expect(stored?.text).toBe("[image unavailable: fetch failed]");
		expect(filesIn(bob)).toEqual([]);
	});

	it("stores too large and sends no request for a size tag over the cap", async () => {
		const sealed = seal(pngOfSize());

		const stored = await receiveOne(offerEvent(alice, bob, sealed, { size: String(6 * 1024 * 1024) }));

		expect(stored?.text).toBe("[image unavailable: too large]");
		expect(requestsTo(alice)).toEqual([]);
	});

	it("stores a bad offer as the placeholder, never the content", async () => {
		const sealed = seal(pngOfSize());
		const event = wrapTagged({ kind: 15, content: "https://evil.example/blob", tags: [["x", sealed.x]] }, alice.sk, bob.pub);

		const stored = await receiveOne(event);

		expect(stored?.text).toBe("[image unavailable: bad offer]");
		expect(requestsTo(alice)).toEqual([]);
	});

	it("drops a kind 15 from a stranger and makes no fetch", async () => {
		const stranger = await boot("s");
		const sealed = seal(pngOfSize());
		const bobWormhole = wormholeFor();
		const bobListener = listen(bob, bobWormhole);
		await bobListener.started;
		try {
			await deliver(offerEvent(stranger, bob, sealed));
			await Bun.sleep(100);
		} finally {
			await bobListener.stop();
		}

		expect(bob.deps.db.recentMessages(10).filter((candidate) => candidate.sender !== "phone")).toEqual([]);
		expect(bobWormhole.runs()).toEqual([]);
		expect(requestsTo(stranger)).toEqual([]);
	});

	it("stores too many pending past the queue depth", async () => {
		for (let at = 0; at < MAX_PENDING_IMAGES; at += 1) {
			bob.deps.db.addMessage({ id: `p${at}`, direction: "in", ts: clock, sender: alice.npub, contact: alice.npub, text: "[image pending]", call: 0 });
			bob.deps.db.addImageFetch({ ...fetchFields(alice, `p${at}`), next_at: clock + 10_000 });
		}
		const sealed = seal(pngOfSize());

		const stored = await receiveOne(offerEvent(alice, bob, sealed));

		expect(stored?.text).toBe("[image unavailable: too many pending]");
	});

	it("marks a received PHI image phi and gives its fetch 24 hours", async () => {
		const sealed = seal(pngOfSize());
		const event = offerEvent(alice, bob, sealed, {}, [["dg-phi", "1"]]);
		const bobListener = listen(bob, wormholeFor({ limits: { receiveMs: 50 } }));
		await bobListener.started;
		try {
			await deliver(event);
			await waitUntil(() => (bob.deps.db.imageFetches()[0]?.attempts ?? 0) >= 1);
		} finally {
			await bobListener.stop();
		}

		expect(row(bob, event.id)?.phi).toBe(1);
		expect(bob.deps.db.imageFetches()[0]?.deadline).toBe(clock + PHI_TTL_SECONDS);
	});

	it("gives a plain image fetch the seven-day message window", async () => {
		const sealed = seal(pngOfSize());
		const event = offerEvent(alice, bob, sealed);
		const bobListener = listen(bob, wormholeFor({ limits: { receiveMs: 50 } }));
		await bobListener.started;
		try {
			await deliver(event);
			await waitUntil(() => (bob.deps.db.imageFetches()[0]?.attempts ?? 0) >= 1);
		} finally {
			await bobListener.stop();
		}

		expect(row(bob, event.id)?.phi).toBe(0);
		expect(bob.deps.db.imageFetches()[0]?.deadline).toBe(clock + MESSAGE_TTL_SECONDS);
	});

	it("hands the hook the finished image once and never the pending row", async () => {
		const sealed = seal(pngOfSize());
		stageAt(alice, sealed.cipher, bob);
		const out = join(shared, "hook.ndjson");
		const hook = {
			kind: "command" as const,
			argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], (await Bun.stdin.text()) + '\\n')", out],
			timeoutMs: 5000,
		};
		const aliceListener = listen(alice, wormholeFor());
		const bobListener = listen(bob, wormholeFor(), { hook });
		await Promise.all([aliceListener.started, bobListener.started]);
		try {
			const event = offerEvent(alice, bob, sealed);
			await deliver(event);
			await settled(bob, event.id);
			await waitUntil(() => existsSync(out) && readFileSync(out, "utf8").trim().length > 0);
			await Bun.sleep(100);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}

		const payloads = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { text: string; file?: { untrusted: boolean } });
		expect(payloads.map((payload) => payload.text)).toEqual(["[image]"]);
		expect(payloads[0]?.file?.untrusted).toBe(true);
	});

	it("kills a running receive on listener shutdown and keeps the fetch for the next start", async () => {
		const sealed = seal(pngOfSize());
		const wormhole = wormholeFor({ receive: "hang", limits: { receiveMs: 60_000 } });
		const bobListener = listen(bob, wormhole);
		await bobListener.started;
		const event = offerEvent(alice, bob, sealed);
		await deliver(event);
		await waitUntil(() => wormhole.runs().length === 1);

		await bobListener.stop();

		const pid = wormhole.runs()[0]?.pid ?? 0;
		await waitUntil(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 3000);
		expect(row(bob, event.id)?.text).toBe("[image pending]");
		expect(bob.deps.db.imageFetches()).toHaveLength(1);
	});

	it("prunes PHI rows on the 30-minute timer of a quiet listener", async () => {
		bob.deps.db.addMessage({ id: "phi", direction: "in", ts: clock, sender: alice.npub, contact: alice.npub, text: "note", call: 0, phi: true });
		const { schedule, timers } = capturingSchedule();
		const bobListener = listen(bob, wormholeFor(), { schedule });
		await bobListener.started;
		try {
			clock += PHI_TTL_SECONDS + 1;
			for (const timer of timers.filter((candidate) => candidate.delayMs === STUCK_RETRY_INTERVAL_MS)) timer.run();
			expect(row(bob, "phi")).toBeUndefined();
		} finally {
			await bobListener.stop();
		}
	});

	it("never stores an expired PHI message again when a relay replays its wrap", async () => {
		const event = wrapTagged({ content: "sensitive", tags: [["dg-phi", "1"]] }, alice.sk, bob.pub);
		await deliver(event);
		const first = listen(bob, wormholeFor());
		await first.started;
		await first.stop();
		expect(row(bob, event.id)).toMatchObject({ text: "[PHI: vault unavailable from +a]", phi: 1 });

		clock += PHI_TTL_SECONDS + 1;
		bob.deps.db.pruneMessages();
		const second = listen(bob, wormholeFor());
		await second.started;
		await second.stop();

		expect(row(bob, event.id)).toBeUndefined();
	});
});

function fetchFields(sender: Phone, id: string): Omit<ImageFetchRow, "attempts"> {
	return {
		message_id: id,
		sender: sender.pub,
		key_id: "number",
		x: "a".repeat(64),
		ox: "b".repeat(64),
		size: 100,
		key: "c".repeat(64),
		nonce: "d".repeat(24),
		next_at: clock,
		deadline: clock + MESSAGE_TTL_SECONDS,
	};
}

describe("createImageReceiver", () => {
	let alice: Phone;
	let bob: Phone;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
		writeFilesOn(bob.deps.db, true);
	});

	function pendingRow(id: string, fields: Partial<ImageFetchRow> = {}): void {
		bob.deps.db.addMessage({ id, direction: "in", ts: clock, sender: alice.npub, contact: alice.npub, text: "[image pending]", call: 0 });
		bob.deps.db.addImageFetch({ ...fetchFields(alice, id), key_id: numberKeyId(bob.deps.db), ...fields });
	}

	function receiver(opts: { schedule?: Schedule; wormhole?: FakeWormhole; pool?: FakePool; finished?: () => void } = {}) {
		const key = { id: numberKeyId(bob.deps.db), pub: bob.pub, sk: bob.sk };
		const used = opts.pool ?? pool;
		return createImageReceiver({
			db: bob.deps.db,
			paths: bob.deps.paths,
			pool: used,
			now: () => clock,
			keys: () => [key],
			schedule: opts.schedule ?? ((() => () => {}) as Schedule),
			wormhole: (opts.wormhole ?? wormholeFor()).deps,
			onFinish: opts.finished ?? (() => {}),
		});
	}

	it("retries with a fresh code each time and doubles the wait", async () => {
		pendingRow("img");
		const { schedule, timers } = capturingSchedule();
		const images = receiver({ schedule, wormhole: wormholeFor({ limits: { receiveMs: 50 } }) });

		images.wake();
		await images.settle();
		expect(bob.deps.db.imageFetches()[0]).toMatchObject({ attempts: 1, next_at: clock + IMAGE_RETRY_BASE_SECONDS });
		expect(timers.map((timer) => timer.delayMs)).toEqual([IMAGE_RETRY_BASE_SECONDS * 1000]);

		clock += IMAGE_RETRY_BASE_SECONDS;
		timers.shift()?.run();
		await images.settle();
		expect(bob.deps.db.imageFetches()[0]).toMatchObject({ attempts: 2, next_at: clock + IMAGE_RETRY_BASE_SECONDS * 2 });

		const codes = requestsTo(alice).map((event) => nip59.unwrapEvent(event, alice.sk).tags.find((tag) => tag[0] === "code")?.[1]);
		expect(codes).toHaveLength(2);
		expect(codes[0]).not.toBe(codes[1]);
	});

	it("stores sender offline once the next retry would pass the deadline", async () => {
		pendingRow("img", { deadline: clock + 30 });
		const finished: string[] = [];
		const images = receiver({ pool: createFakePool([]), finished: () => finished.push("done") });

		images.wake();
		await images.settle();

		expect(row(bob, "img")?.text).toBe("[image unavailable: sender offline]");
		expect(bob.deps.db.imageFetches()).toEqual([]);
		expect(finished).toEqual(["done"]);
	});

	async function transferWhile(sealed: ReturnType<typeof seal>, during: () => void, wormhole: FakeWormhole) {
		const images = receiver({ wormhole });
		images.wake();
		await waitUntil(() => requestsTo(alice).length === 1);
		const request = requestsTo(alice)[0] as NostrEvent;
		const code = nip59.unwrapEvent(request, alice.sk).tags.find((tag) => tag[0] === "code")?.[1] as string;
		during();
		writeFileSync(join(wormhole.rendezvous, `${code}.name`), sealed.x);
		writeFileSync(join(wormhole.rendezvous, code), sealed.cipher);
		await images.settle();
	}

	function sealedFields(sealed: ReturnType<typeof seal>): Partial<ImageFetchRow> {
		return { x: sealed.x, ox: sealed.ox, size: sealed.cipher.length, key: sealed.key, nonce: sealed.nonce };
	}

	it("writes no file when the message is pruned while the transfer runs", async () => {
		const sealed = seal(pngOfSize());
		bob.deps.db.addMessage({ id: "img", direction: "in", ts: clock, sender: alice.npub, contact: alice.npub, text: "[image pending]", call: 0, phi: true });
		bob.deps.db.addImageFetch({ ...fetchFields(alice, "img"), key_id: numberKeyId(bob.deps.db), ...sealedFields(sealed), deadline: clock + PHI_TTL_SECONDS });

		await transferWhile(
			sealed,
			() => {
				clock += PHI_TTL_SECONDS + 1;
				bob.deps.db.pruneMessages();
			},
			wormholeFor(),
		);

		expect(filesIn(bob)).toEqual([]);
		expect(row(bob, "img")).toBeUndefined();
		expect(bob.deps.db.imageFetches()).toEqual([]);
	});

	it("writes no file and stores sender offline when the deadline passes while the transfer runs", async () => {
		const sealed = seal(pngOfSize());
		pendingRow("img", { ...sealedFields(sealed), deadline: clock + 60 });

		await transferWhile(
			sealed,
			() => {
				clock += 60;
			},
			wormholeFor(),
		);

		expect(filesIn(bob)).toEqual([]);
		expect(row(bob, "img")).toMatchObject({ text: "[image unavailable: sender offline]", file: null });
		expect(bob.deps.db.imageFetches()).toEqual([]);
	});

	function phiPendingRow(id: string, sealed: ReturnType<typeof seal>, deadline: number): void {
		bob.deps.db.addMessage({ id, direction: "in", ts: clock, sender: alice.npub, contact: alice.npub, text: "[image pending]", call: 0, phi: true });
		bob.deps.db.addImageFetch({ ...fetchFields(alice, id), key_id: numberKeyId(bob.deps.db), ...sealedFields(sealed), deadline });
	}

	it("retries a PHI image with the normal backoff when no vault key can be reached, and writes no file", async () => {
		const sealed = seal(pngOfSize());
		phiPendingRow("img", sealed, clock + PHI_TTL_SECONDS);

		await transferWhile(sealed, () => {}, wormholeFor());

		expect(row(bob, "img")?.text).toBe("[image pending]");
		expect(bob.deps.db.imageFetches()[0]).toMatchObject({ attempts: 1, next_at: clock + IMAGE_RETRY_BASE_SECONDS });
		expect(filesIn(bob)).toEqual([]);
		expect(bob.deps.db.listVaultItems()).toEqual([]);
	});

	it("stores vault unavailable once the next PHI retry would pass the deadline", async () => {
		const sealed = seal(pngOfSize());
		phiPendingRow("img", sealed, clock + 30);

		await transferWhile(sealed, () => {}, wormholeFor());

		expect(row(bob, "img")).toMatchObject({ text: "[image unavailable: vault unavailable]", file: null });
		expect(bob.deps.db.imageFetches()).toEqual([]);
		expect(filesIn(bob)).toEqual([]);
	});

	it("stores sender offline without a request when the deadline already passed", async () => {
		pendingRow("img", { deadline: clock - 1 });
		const images = receiver();

		images.wake();
		await images.settle();

		expect(row(bob, "img")?.text).toBe("[image unavailable: sender offline]");
		expect(pool.events).toEqual([]);
	});

	function storedImage(id: string, plain: Buffer, phi: boolean): string {
		const ox = sha256(plain);
		const dir = join(bob.deps.paths.phoneRoot, FILES_DIR);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, `${ox}.png`), plain, { mode: 0o600 });
		const file = JSON.stringify({ sha256: ox, type: "image/png", size: plain.length });
		bob.deps.db.addMessage({ id, direction: "in", ts: clock, sender: alice.npub, contact: alice.npub, text: "[image]", call: 0, file, phi });
		return ox;
	}

	it("reuses a stored file with the same hash and fetches nothing", async () => {
		const plain = pngOfSize();
		const ox = storedImage("earlier", plain, false);
		pendingRow("img", { ox });
		const wormhole = wormholeFor();
		const images = receiver({ wormhole });

		images.wake();
		await images.settle();

		expect(row(bob, "img")).toMatchObject({ text: "[image]", file: JSON.stringify({ sha256: ox, type: "image/png", size: plain.length }) });
		expect(pool.events).toEqual([]);
		expect(wormhole.runs()).toEqual([]);
	});

	it("never reuses a file that only PHI rows hold, so a plain row cannot keep it past 24 hours", async () => {
		const ox = storedImage("phi-earlier", pngOfSize(), true);
		pendingRow("img", { ox, deadline: clock + 30 });
		const images = receiver({ pool: createFakePool([]) });

		images.wake();
		await images.settle();

		expect(row(bob, "img")?.text).toBe("[image unavailable: sender offline]");
		expect(row(bob, "img")?.file).toBeNull();
	});

	it("stores fetch failed when the wormhole tool stays unavailable to the deadline", async () => {
		pendingRow("img", { deadline: clock + 30 });
		const wormhole = wormholeFor();
		wormhole.deps.pins = {};
		const images = receiver({ wormhole });

		images.wake();
		await images.settle();

		expect(row(bob, "img")).toMatchObject({ text: "[image unavailable: fetch failed]", file: null });
		expect(filesIn(bob)).toEqual([]);
		expect(bob.deps.db.imageFetches()).toEqual([]);
	});

	it("stores storage full and fetches nothing when files/ is over the byte cap", async () => {
		const dir = join(bob.deps.paths.phoneRoot, FILES_DIR);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const big = join(dir, `${"f".repeat(64)}.png`);
		writeFileSync(big, "");
		truncateSync(big, FILES_BYTE_CAP);
		pendingRow("img");
		const images = receiver();

		images.wake();
		await images.settle();

		expect(row(bob, "img")?.text).toBe("[image unavailable: storage full]");
		expect(pool.events).toEqual([]);
	});

	it("stores daily limit past the per-contact daily count", async () => {
		for (let at = 0; at <= DAILY_REQUEST_CAP; at += 1) pendingRow(`img${String(at).padStart(2, "0")}`);
		const images = receiver({ pool: createFakePool([]) });

		images.wake();
		await images.settle();

		const texts = bob.deps.db.recentMessages(100).map((candidate) => candidate.text);
		expect(texts.filter((text) => text === "[image unavailable: daily limit]")).toHaveLength(1);
		expect(bob.deps.db.imageFetches()).toHaveLength(DAILY_REQUEST_CAP);
	});

	it("writes nothing to stderr about a failed fetch", async () => {
		pendingRow("img", { deadline: clock + 30 });
		const writes: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const images = receiver({ pool: createFakePool([]) });
			images.wake();
			await images.settle();
		} finally {
			process.stderr.write = original;
		}

		expect(writes.join("")).not.toContain("c".repeat(64));
		expect(writes.join("")).not.toContain(alice.pub);
	});
});

describe("received row text", () => {
	it("never equals the kind 15 content on the direct, thread, or held path", async () => {
		const alice = await boot("a");
		const bob = await boot("b");
		const cara = await boot("c");
		link(alice, "b", bob, "a");
		bob.deps.db.ensureKeyRow("other", () => ({ nsec: null, in_store: 1 }));
		addContact(bob.deps.db, { npub: cara.npub, handle: "c", relays: RELAYS, keyId: "other", addedAt: clock, via: "accept" });
		writeFilesOn(bob.deps.db, true);
		const sealed = seal(pngOfSize());
		const tags = [
			["encryption-algorithm", "aes-gcm"],
			["decryption-key", sealed.key],
			["decryption-nonce", sealed.nonce],
			["x", sealed.x],
			["ox", sealed.ox],
			["size", String(sealed.cipher.length)],
		];
		const content = `${WORMHOLE_SCHEME}${sealed.x}`;
		const direct = wrapTagged({ kind: 15, content, tags }, alice.sk, bob.pub);
		const thread = nip59.wrapEvent({ kind: 15, content, tags: [["p", bob.pub], ["subject", "ops"], ...tags] }, alice.sk, bob.pub);
		const held = nip59.wrapEvent({ kind: 15, content, tags: [["p", bob.pub], ["p", cara.pub], ["subject", "ops"], ...tags] }, alice.sk, bob.pub);
		const bobListener = listen(bob, wormholeFor({ limits: { receiveMs: 50 } }));
		await bobListener.started;
		try {
			for (const event of [direct, thread, held]) await deliver(event);
			await waitUntil(() => bob.deps.db.listPending().length === 1 && bob.deps.db.recentMessages(10).filter((candidate) => candidate.sender === alice.npub).length === 2);
		} finally {
			await bobListener.stop();
		}

		const texts = [...bob.deps.db.recentMessages(10).map((candidate) => candidate.text), ...bob.deps.db.listPending().map((pending) => pending.text)];
		expect(texts).not.toContain(content);
		expect(bob.deps.db.listPending()[0]?.text).toBe("[image]");
	});
});

describe("PHI vault receive", () => {
	const PLACEHOLDER = /^\[PHI: vault item (a-\d{12}-[0-9a-f]{4}) from \+a\]$/;
	let alice: Phone;
	let bob: Phone;
	let creds: FakeCredentials;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
		phoneFiles("on", alice.deps);
		phoneFiles("on", bob.deps);
		creds = createFakeCredentials({ session: false, granted: true });
		creds.store.set(vaultKeyName(keyPeriod(clock)), "22".repeat(32));
	});

	function vaultName(text: string | undefined): string {
		const match = PLACEHOLDER.exec(text ?? "");
		if (!match) throw new Error(`not a vault placeholder: ${text}`);
		return match[1] as string;
	}

	async function vaultContent(name: string): Promise<Buffer> {
		const item = bob.deps.db.vaultItem(name);
		if (!item) throw new Error(`no vault item ${name}`);
		return openVaultItem(creds.deps(), bob.deps.paths.phoneRoot, item);
	}

	function hookTo(out: string) {
		return {
			kind: "command" as const,
			argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], (await Bun.stdin.text()) + '\\n')", out],
			timeoutMs: 5000,
		};
	}

	it("seals a received PHI text into the vault, and the row, messages, and the hook show only the placeholder", async () => {
		const out = join(shared, "hook.ndjson");
		await deliver(wrapTagged({ content: "patient Jane Roe", tags: [["dg-phi", "1"]] }, alice.sk, bob.pub));
		const bobListener = listen(bob, wormholeFor(), { vaultClient: creds.deps().vaultClient, hook: hookTo(out) });
		await bobListener.started;
		try {
			await waitUntil(() => existsSync(out) && readFileSync(out, "utf8").trim().length > 0);
		} finally {
			await bobListener.stop();
		}

		const [stored] = bob.deps.db.recentMessages(10);
		const name = vaultName(stored?.text);
		expect(stored?.phi).toBe(1);
		expect((await vaultContent(name)).toString()).toBe("patient Jane Roe");
		expect(bob.deps.db.vaultItem(name)?.sender).toBe(alice.npub);
		const hooked = JSON.parse(readFileSync(out, "utf8").trim()) as { text: string };
		expect(hooked.text).toBe(stored?.text);
		const printed: string[] = [];
		bob.deps.write = (text) => printed.push(text);
		phoneInbox({}, bob.deps);
		expect(printed.join("").includes("Jane")).toBe(false);
		expect(printed.join("")).toContain(stored?.text as string);
		expect(readFileSync(out, "utf8").includes("Jane")).toBe(false);
	});

	it("stores no content when no vault key can be reached", async () => {
		await deliver(wrapTagged({ content: "patient Jane Roe", tags: [["dg-phi", "1"]] }, alice.sk, bob.pub));
		const bobListener = listen(bob, wormholeFor());
		await bobListener.started;
		await bobListener.stop();

		expect(bob.deps.db.recentMessages(10).map((candidate) => candidate.text)).toEqual(["[PHI: vault unavailable from +a]"]);
		expect(bob.deps.db.listVaultItems()).toEqual([]);
	});

	it("expires a received item on the 30-minute timer", async () => {
		await deliver(wrapTagged({ content: "patient Jane Roe", tags: [["dg-phi", "1"]] }, alice.sk, bob.pub));
		const { schedule, timers } = capturingSchedule();
		const bobListener = listen(bob, wormholeFor(), { schedule, vaultClient: creds.deps().vaultClient });
		await bobListener.started;
		try {
			await waitUntil(() => bob.deps.db.listVaultItems().length === 1);
			clock += VAULT_TTL_SECONDS;
			for (const timer of timers.filter((candidate) => candidate.delayMs === STUCK_RETRY_INTERVAL_MS)) timer.run();
			expect(bob.deps.db.listVaultItems()).toEqual([]);
			expect(readdirSync(join(bob.deps.paths.phoneRoot, VAULT_DIR))).toEqual([]);
		} finally {
			await bobListener.stop();
		}
	});

	it("decrypts a received PHI image straight into the vault, never into files/ or the hook", async () => {
		const plain = pngOfSize();
		const sealed = seal(plain);
		stageAt(alice, sealed.cipher, bob);
		const out = join(shared, "hook.ndjson");
		const aliceListener = listen(alice, wormholeFor());
		const bobListener = listen(bob, wormholeFor(), { vaultClient: creds.deps().vaultClient, hook: hookTo(out) });
		await Promise.all([aliceListener.started, bobListener.started]);
		let stored: ReturnType<typeof row>;
		try {
			const event = offerEvent(alice, bob, sealed, {}, [["dg-phi", "1"]]);
			await deliver(event);
			stored = await settled(bob, event.id);
			await waitUntil(() => existsSync(out) && readFileSync(out, "utf8").trim().length > 0);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}

		const name = vaultName(stored?.text);
		expect(stored?.file).toBeNull();
		expect(filesIn(bob)).toEqual([]);
		expect((await vaultContent(name)).equals(plain)).toBe(true);
		expect(bob.deps.db.vaultItem(name)?.type).toBe("image/png");
		const hooked = JSON.parse(readFileSync(out, "utf8").trim()) as { text: string; file?: unknown };
		expect(hooked.text).toBe(stored?.text as string);
		expect(hooked.file).toBeUndefined();
	});
});

describe("extensions", () => {
	let alice: Phone;
	let bob: Phone;
	let creds: FakeCredentials;

	beforeEach(async () => {
		alice = await boot("a");
		bob = await boot("b");
		link(alice, "b", bob, "a");
		phoneFiles("on", alice.deps);
		phoneFiles("on", bob.deps);
		creds = createFakeCredentials({ session: false, granted: true });
		creds.store.set(vaultKeyName(keyPeriod(clock)), "22".repeat(32));
	});

	function hookTo(out: string) {
		return {
			kind: "command" as const,
			argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], (await Bun.stdin.text()) + '\\n')", out],
			timeoutMs: 5000,
		};
	}

	async function receive(opts: { hook?: string } = {}): Promise<void> {
		const bobListener = listen(bob, wormholeFor(), { vaultClient: creds.deps().vaultClient, ...(opts.hook ? { hook: hookTo(opts.hook) } : {}) });
		await bobListener.started;
		try {
			if (opts.hook) {
				const out = opts.hook;
				await waitUntil(() => existsSync(out) && readFileSync(out, "utf8").trim().length > 0);
			}
		} finally {
			await bobListener.stop();
		}
	}

	it("stores the agent a message is for and the agent it came from, notes the sender's extension, and passes both to the hook", async () => {
		const out = join(shared, "hook.ndjson");
		await phoneSay("+b/merc", "hi merc", alice.deps, { as: "kit" });
		await receive({ hook: out });

		const [stored] = bob.deps.db.recentMessages(10);
		expect(stored).toMatchObject({ direction: "in", text: "hi merc", ext: "merc", peer_ext: "kit" });
		expect(bob.deps.db.contactExts(alice.npub)).toEqual([{ ext: "kit", last_seen: stored?.ts as number }]);
		const hooked = JSON.parse(readFileSync(out, "utf8").trim()) as Record<string, unknown>;
		expect(hooked).toMatchObject({ handle: "+a", text: "hi merc", ext: "merc", from_ext: "kit" });
	});

	it("leaves the hook payload without ext fields for a shared message", async () => {
		const out = join(shared, "hook.ndjson");
		await phoneSay("+b", "hi all", alice.deps);
		await receive({ hook: out });

		const hooked = JSON.parse(readFileSync(out, "utf8").trim()) as Record<string, unknown>;
		expect(hooked.ext).toBeUndefined();
		expect(hooked.from_ext).toBeUndefined();
		expect(bob.deps.db.recentMessages(10)[0]).toMatchObject({ ext: null, peer_ext: null });
	});

	it("treats a message whose tags break the name rule as shared and notes no extension", async () => {
		await deliver(wrapTagged({ content: "sneaky", tags: [["dg-ext", "../../etc"], ["dg-from-ext", "$(id)"]] }, alice.sk, bob.pub));
		await receive();

		expect(bob.deps.db.recentMessages(10)[0]).toMatchObject({ text: "sneaky", ext: null, peer_ext: null });
		expect(bob.deps.db.contactExts(alice.npub)).toEqual([]);
	});

	it("files a #group message machine-wide even when it names an extension, keeping the sender's", async () => {
		await phoneThreadNew("#room", ["+b"], {}, alice.deps);
		await phoneSay("#room", "to the room", alice.deps, { as: "kit" });
		await receive();

		const stored = bob.deps.db.recentMessages(10).find((candidate) => candidate.text === "to the room");
		expect(stored?.thread_id).not.toBeNull();
		expect(stored).toMatchObject({ ext: null, peer_ext: "kit" });
	});

	it("records the extension on a vault item made from received PHI text", async () => {
		await phoneSay("+b/merc", "patient Jane Roe", alice.deps, { phi: true });
		await receive();

		const [item] = bob.deps.db.listVaultItems();
		expect(item?.ext).toBe("merc");
		expect(bob.deps.db.recentMessages(10)[0]?.ext).toBe("merc");
	});

	it("records the extension on a vault item made from a received PHI image", async () => {
		const plain = pngOfSize();
		const sealed = seal(plain);
		stageAt(alice, sealed.cipher, bob);
		const aliceListener = listen(alice, wormholeFor());
		const bobListener = listen(bob, wormholeFor(), { vaultClient: creds.deps().vaultClient });
		await Promise.all([aliceListener.started, bobListener.started]);
		try {
			const event = offerEvent(alice, bob, sealed, {}, [["dg-phi", "1"], ["dg-ext", "merc"]]);
			await deliver(event);
			await settled(bob, event.id);
		} finally {
			await bobListener.stop();
			await aliceListener.stop();
		}

		const [item] = bob.deps.db.listVaultItems();
		expect(item?.type).toBe("image/png");
		expect(item?.ext).toBe("merc");
	});
});
