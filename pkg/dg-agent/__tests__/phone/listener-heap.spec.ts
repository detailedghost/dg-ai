import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { measureSlope, settledHeap } from "@dg/dg-daemon/heap-slope";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { ring } from "../../src/phone/chat";
import { PhoneDb } from "../../src/phone/db";
import { createFileKey, type KeyClient } from "../../src/phone/keys";
import { type ListenerDeps, runListener } from "../../src/phone/listener";
import type { Schedule } from "../../src/phone/hook";
import { bumpAdmissionEpoch, numberKeyId, writeNumber } from "../../src/phone/store";

let home: string;
let paths: DgPaths;
let db: PhoneDb;
let now: number;

beforeEach(() => {
	now = Math.floor(Date.now() / 1000);
	home = mkdtempSync(join(tmpdir(), "dg-phone-heap-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	db = PhoneDb.open(paths, () => now);
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("phone listener heap stays flat across reconnects", () => {
	it("holds no subscription or timer state when every liveness probe fails and the admission epoch moves", async () => {
		const secret = "ab".repeat(32);
		const numberSk = createFileKey(db, numberKeyId(db)) as Uint8Array;
		writeNumber(db, { secret, as: "dg" });
		const held = [ring("hi", generateSecretKey(), getPublicKey(numberSk), secret, "mary")];
		let subscriptions = 0;
		const sink: ReturnType<ListenerDeps["createPool"]> = {
			publish: (relays) => relays.map(() => Promise.resolve("")),
			querySync: async (_relays, filter) => held.filter((event) => event.created_at >= (filter.since ?? 0)),
			subscribe: () => {
				subscriptions++;
				return {
					close: () => {
						subscriptions--;
					},
				};
			},
			close: () => {},
		};

		const timers: { run: () => void }[] = [];
		const schedule: Schedule = (_delay, run) => {
			const entry = { run };
			timers.push(entry);
			return () => {
				const at = timers.indexOf(entry);
				if (at >= 0) timers.splice(at, 1);
			};
		};
		let stop = () => {};
		let ready = () => {};
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const run = runListener({
			paths,
			db,
			sessionClient: async () => undefined,
			grantClient: (): KeyClient => {
				throw new Error("no grant in file-mode tests");
			},
			createPool: () => sink,
			now: () => now,
			pid: 4244,
			schedule,
			liveness: { minMs: 1, maxMs: 2, confirmMs: 1, waitMs: 1, random: () => 0 },
			onSignal: (signal, handler) => {
				if (signal !== "SIGTERM") return;
				stop = handler;
				ready();
			},
		});
		await started;

		const step = async () => {
			now += 300;
			bumpAdmissionEpoch(db);
			for (const due of timers.splice(0)) due.run();
			await new Promise((resolve) => setTimeout(resolve, 6));
		};
		const result = await measureSlope(step, settledHeap, { warmup: 30, batches: 4, iterations: 150 });
		const live = subscriptions;
		const waiting = timers.length;
		stop();
		await run;

		console.log(`listener reconnect slopes: ${result.slopes.join(", ")} bytes per iteration`);
		expect(live).toBe(1);
		expect(waiting).toBeLessThanOrEqual(4);
		expect(result.leaking).toBe(false);
	}, 60_000);
});
