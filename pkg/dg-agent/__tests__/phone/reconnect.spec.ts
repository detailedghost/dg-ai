import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phoneAccept, phoneNumber, phoneSay, type PhoneDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import type { KeyClient } from "../../src/phone/keys";
import { runListener, type ListenerDeps } from "../../src/phone/listener";
import { createFakePool, makePhoneDeps, parseNdjson, type FakePool } from "./fake-pool";

const homes: string[] = [];
const dbs: PhoneDb[] = [];

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-phone-reconnect-"));
	homes.push(dir);
	return dir;
}

function deps(dir: string, pool: FakePool, write: (text: string) => void): PhoneDeps {
	const phone = makePhoneDeps({ home: dir, pool, write, now: Math.floor(Date.now() / 1000) });
	dbs.push(phone.db);
	return phone;
}

async function listenOnce(phone: PhoneDeps, pool: FakePool): Promise<void> {
	let stop = () => {};
	let markReady = () => {};
	const opened = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	const listener: ListenerDeps = {
		paths: phone.paths,
		db: phone.db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant");
		},
		createPool: () => ({ ...pool, close: () => {} }),
		now: () => Math.floor(Date.now() / 1000),
		pid: 4242,
		schedule: () => () => {},
		onSignal: (signal, handler) => {
			if (signal === "SIGTERM") {
				stop = handler;
				markReady();
			}
		},
	};
	const run = runListener(listener);
	await opened;
	stop();
	await run;
}

afterEach(() => {
	for (const db of dbs) db.close();
	dbs.length = 0;
	for (const dir of homes) rmSync(dir, { recursive: true, force: true });
	homes.length = 0;
});

describe("reconnect catch-up", () => {
	it("delivers an accept and a later message exactly once when the receiver was down", async () => {
		const pool = createFakePool();
		const receiverOut: string[] = [];
		const senderOut: string[] = [];
		const receiver = deps(home(), pool, (text) => receiverOut.push(text));
		const sender = deps(home(), pool, (text) => senderOut.push(text));
		await phoneNumber({ as: "ada" }, receiver);
		const card = (parseNdjson(receiverOut)[0] as { card: string }).card;
		await phoneNumber({ as: "bea" }, sender);
		await phoneAccept(card, "hello-from-bea", sender);
		await phoneSay("+ada", "ping-from-bea", sender);

		await listenOnce(receiver, pool);
		const first = receiver.db.recentMessages(20).map((row) => row.text);
		await listenOnce(receiver, pool);
		const second = receiver.db.recentMessages(20).map((row) => row.text);

		expect(first.filter((text) => text === "hello-from-bea")).toEqual(["hello-from-bea"]);
		expect(first.filter((text) => text === "ping-from-bea")).toEqual(["ping-from-bea"]);
		expect(second.filter((text) => text === "hello-from-bea")).toEqual(["hello-from-bea"]);
		expect(second.filter((text) => text === "ping-from-bea")).toEqual(["ping-from-bea"]);
		expect(senderOut.length).toBeGreaterThan(0);
	});
});
