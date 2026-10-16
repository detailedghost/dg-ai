import { describe, expect, test } from "bun:test";
import { backoffMs, runTicker } from "../src/automation/ticker";
import { createRecordedLog } from "./support/fakes";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("backoffMs", () => {
	test("doubles from one second and caps at 30 minutes", () => {
		expect([1, 2, 3, 4].map(backoffMs)).toEqual([1000, 2000, 4000, 8000]);
		expect(backoffMs(11)).toBe(1_024_000);
		expect(backoffMs(12)).toBe(30 * 60_000);
		expect(backoffMs(40)).toBe(30 * 60_000);
	});
});

describe("runTicker", () => {
	function setup(tick: (n: number, controller: AbortController) => Promise<void>) {
		const controller = new AbortController();
		const sleeps: number[] = [];
		const log = createRecordedLog();
		let calls = 0;
		const done = runTicker({
			name: "sink",
			intervalMs: 300_000,
			tick: async () => {
				calls += 1;
				await tick(calls, controller);
			},
			signal: controller.signal,
			log,
			sleep: async (ms) => {
				sleeps.push(ms);
				await flush();
			},
		});
		return { controller, sleeps, log, done, calls: () => calls };
	}

	test("ticks at the interval until it aborts", async () => {
		const run = setup(async (n, controller) => {
			if (n === 3) controller.abort();
		});
		await run.done;
		expect(run.calls()).toBe(3);
		expect(run.sleeps).toEqual([300_000, 300_000, 300_000]);
		expect(run.log.lines).toEqual([]);
	});

	test("logs a throw, backs off exponentially, and resets after a success", async () => {
		const run = setup(async (n, controller) => {
			if (n <= 3) throw new Error(`boom ${n}`);
			if (n === 5) throw new Error("again");
			if (n === 6) controller.abort();
		});
		await run.done;
		expect(run.sleeps).toEqual([1000, 2000, 4000, 300_000, 1000, 300_000]);
		expect(run.log.lines.map((line) => line.level)).toEqual(["warn", "warn", "warn", "warn"]);
		expect(run.log.lines[0]?.message).toContain("boom 1");
	});

	test("caps the backoff at 30 minutes", async () => {
		const run = setup(async (n, controller) => {
			if (n === 15) controller.abort();
			throw new Error("down");
		});
		await run.done;
		expect(Math.max(...run.sleeps)).toBe(30 * 60_000);
	});

	test("does not tick when it starts aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let ticks = 0;
		await runTicker({
			name: "sink",
			intervalMs: 1,
			tick: async () => {
				ticks += 1;
			},
			signal: controller.signal,
			log: createRecordedLog(),
		});
		expect(ticks).toBe(0);
	});

	test("stops through the real sleep when the signal aborts", async () => {
		const controller = new AbortController();
		const done = runTicker({
			name: "sink",
			intervalMs: 3_600_000,
			tick: async () => {},
			signal: controller.signal,
			log: createRecordedLog(),
		});
		await flush();
		controller.abort();
		await done;
	});

	test("stays quiet when a tick fails because it aborted", async () => {
		const run = setup(async (_n, controller) => {
			controller.abort();
			throw new Error("aborted");
		});
		await run.done;
		expect(run.log.lines).toEqual([]);
	});
});
