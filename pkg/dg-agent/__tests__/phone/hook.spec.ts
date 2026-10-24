import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { PhoneDb } from "../../src/phone/db";
import { createHookRunner, type Schedule } from "../../src/phone/hook";
import { ON_MESSAGE_MAX_ATTEMPTS, type CommandPushTarget } from "../../src/phone/push";
import { addContact } from "../../src/phone/store";

const NOW = 1_800_000_000;
let home: string;
let paths: DgPaths;
let db: PhoneDb;
let scratch: string;

/** `-e` inline script: appends raw stdin to `outFile` and exits 1 while `counterFile` holds a
 * positive count (decrementing it each run), else exits 0. Proves the message never reaches argv. */
const COUNTED_HOOK_SRC =
	"const [c,o]=process.argv.slice(1);const s=await Bun.stdin.text();" +
	"const p=await Bun.file(o).exists()?await Bun.file(o).text():'';" +
	"await Bun.write(o,p+s+'\\n');const r=Number(await Bun.file(c).text());" +
	"if(r>0){await Bun.write(c,String(r-1));process.exit(1)}process.exit(0)";

const ALWAYS_FAILS: CommandPushTarget = { kind: "command", argv: [process.execPath, "-e", "process.exit(1)"], timeoutMs: 2000 };

function countedHook(failTimes: number): { target: CommandPushTarget; outFile: string } {
	const counterFile = join(scratch, `counter-${Math.random()}`);
	const outFile = join(scratch, `out-${Math.random()}`);
	writeFileSync(counterFile, String(failTimes));
	return {
		target: { kind: "command", argv: [process.execPath, "-e", COUNTED_HOOK_SRC, counterFile, outFile], timeoutMs: 2000 },
		outFile,
	};
}

function deliveredPayloads(outFile: string): Record<string, unknown>[] {
	return readFileSync(outFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function message(id: string, ts: number, overrides: Partial<{ sender: string; contact: string; text: string; call: number }> = {}) {
	return {
		id,
		ts,
		sender: "npub1them",
		contact: "npub1them",
		text: "hi",
		call: 0,
		direction: "in" as const,
		...overrides,
	};
}

function fakeSchedule(): { schedule: Schedule; delays: () => number[]; fireNext: () => void } {
	const calls: { delayMs: number; run: () => void }[] = [];
	const schedule: Schedule = (delayMs, run) => {
		const entry = { delayMs, run };
		calls.push(entry);
		return () => {
			const i = calls.indexOf(entry);
			if (i >= 0) calls.splice(i, 1);
		};
	};
	return {
		schedule,
		delays: () => calls.map((c) => c.delayMs),
		fireNext: () => calls.shift()?.run(),
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-hook-"));
	scratch = mkdtempSync(join(tmpdir(), "dg-phone-hook-scratch-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	db = PhoneDb.open(paths, () => NOW);
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

describe("createHookRunner", () => {
	it("delivers every unread row oldest first and marks each read", async () => {
		db.addMessage(message("b", NOW + 1));
		db.addMessage(message("a", NOW));
		db.ensureKeyRow("default", () => ({ nsec: null, in_store: 1 }));
		addContact(db, { npub: "npub1them", handle: "velora", relays: [], keyId: "default", addedAt: NOW, via: "accept" });
		const { target, outFile } = countedHook(0);

		await createHookRunner(db, target, fakeSchedule().schedule).notify();

		expect(db.unreadMessages()).toEqual([]);
		const payloads = deliveredPayloads(outFile);
		expect(payloads.map((p) => p.id)).toEqual(["a", "b"]);
		expect(payloads[0]).toEqual({ id: "a", ts: NOW, from: "npub1them", handle: "velora", text: "hi" });
	});

	it("blocks newer rows while the oldest one fails, then lets them through once it succeeds", async () => {
		db.addMessage(message("a", NOW));
		db.addMessage(message("b", NOW + 1));
		const { target, outFile } = countedHook(1);
		const { schedule, delays, fireNext } = fakeSchedule();
		const runner = createHookRunner(db, target, schedule);

		await runner.notify();
		expect(delays()).toEqual([5000]);
		expect(deliveredPayloads(outFile).map((p) => p.id)).toEqual(["a"]);
		expect(db.unreadMessages().map((m) => m.id)).toEqual(["a", "b"]);

		fireNext();
		await runner.settle();

		expect(db.unreadMessages()).toEqual([]);
		expect(deliveredPayloads(outFile).map((p) => p.id)).toEqual(["a", "a", "b"]);
	});

	it("uses the 5 s then 30 s backoff when a message fails twice before succeeding", async () => {
		db.addMessage(message("a", NOW));
		const { target } = countedHook(2);
		const { schedule, delays, fireNext } = fakeSchedule();
		const runner = createHookRunner(db, target, schedule);

		await runner.notify();
		expect(delays()).toEqual([5000]);

		fireNext();
		await runner.settle();
		expect(delays()).toEqual([30000]);

		fireNext();
		await runner.settle();

		expect(db.unreadMessages()).toEqual([]);
		expect(db.recentMessages(1)[0]?.attempts).toBe(2);
	});

	it("skips a row once it hits the attempt cap, letting newer rows flow, and marks it stuck", async () => {
		db.addMessage(message("m1", NOW));
		db.addMessage(message("m2", NOW + 1, { sender: "npub1other", contact: "npub1other" }));
		const succeeds: CommandPushTarget = { kind: "command", argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 2000 };
		const { schedule, fireNext } = fakeSchedule();
		const runner = createHookRunner(db, ALWAYS_FAILS, schedule);

		await runner.notify();
		for (let i = 0; i < ON_MESSAGE_MAX_ATTEMPTS - 1; i++) {
			fireNext();
			await runner.settle();
		}

		expect(db.recentMessages(2).find((m) => m.id === "m1")).toMatchObject({ attempts: ON_MESSAGE_MAX_ATTEMPTS, read_at: null });

		const succeedRunner = createHookRunner(db, succeeds, fakeSchedule().schedule);
		await succeedRunner.notify();

		expect(db.recentMessages(2).find((m) => m.id === "m2")?.read_at).not.toBeNull();
		expect(db.recentMessages(2).find((m) => m.id === "m1")).toMatchObject({ attempts: ON_MESSAGE_MAX_ATTEMPTS, read_at: null });
	});

	it("stop cancels a pending retry and keeps an attempt that resolves afterward from arming a new one", async () => {
		db.addMessage(message("a", NOW));
		const { schedule, delays } = fakeSchedule();
		const runner = createHookRunner(db, ALWAYS_FAILS, schedule);

		const notified = runner.notify();
		runner.stop();
		await notified;
		await runner.settle();

		expect(delays()).toEqual([]);
		expect(db.recentMessages(1)[0]).toMatchObject({ attempts: 1, read_at: null });
	});

	it("settle waits for the delivery already in flight, even after a coalesced notify and a stop", async () => {
		db.addMessage(message("a", NOW));
		const { target, outFile } = countedHook(0);
		const runner = createHookRunner(db, target, fakeSchedule().schedule);

		runner.notify();
		runner.notify();
		runner.stop();
		await runner.settle();

		expect(db.recentMessages(1)[0]?.read_at).not.toBeNull();
		expect(deliveredPayloads(outFile)).toHaveLength(1);
	});

	it("a notify that arrives while a delivery is already in flight does not recurse forever once the queue drains", async () => {
		db.addMessage(message("a", NOW));
		const { target } = countedHook(0);
		const runner = createHookRunner(db, target, fakeSchedule().schedule);

		const first = runner.notify();
		const second = runner.notify();
		await first;
		await second;
		await runner.settle();

		expect(db.recentMessages(1)[0]?.read_at).not.toBeNull();
	});

	it("retryStuck gives a stuck row one fresh attempt without blocking on failure", async () => {
		db.addMessage(message("m1", NOW));
		for (let i = 0; i < ON_MESSAGE_MAX_ATTEMPTS; i++) db.bumpAttempts("m1");
		const { target } = countedHook(0);
		const runner = createHookRunner(db, target, fakeSchedule().schedule);

		await runner.retryStuck();

		expect(db.recentMessages(1)[0]?.read_at).not.toBeNull();
	});

	it("a retryStuck that races a notify is folded in, not dropped: both the live row and the stuck row end up read", async () => {
		db.addMessage(message("stuck", NOW));
		for (let i = 0; i < ON_MESSAGE_MAX_ATTEMPTS; i++) db.bumpAttempts("stuck");
		db.addMessage(message("live", NOW + 1));
		const { target } = countedHook(0);
		const runner = createHookRunner(db, target, fakeSchedule().schedule);

		const notified = runner.notify();
		const retried = runner.retryStuck();
		await notified;
		await retried;
		await runner.settle();

		const rows = db.recentMessages(2);
		expect(rows.find((m) => m.id === "live")?.read_at).not.toBeNull();
		expect(rows.find((m) => m.id === "stuck")?.read_at).not.toBeNull();
	});
});
