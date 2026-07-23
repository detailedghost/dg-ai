import { describe, expect, it } from "bun:test";
import { createSerialQueue } from "../src/index";

const tick = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

describe("createSerialQueue", () => {
	it("runs tasks one-at-a-time in enqueue order, never overlapping", async () => {
		const enqueue = createSerialQueue();
		const events: string[] = [];
		const task = (id: string, ms: number) => async () => {
			events.push(`${id}:start`);
			await tick(ms);
			events.push(`${id}:end`);
		};
		// B is enqueued while A (slower) is still running: B must still wait for A.
		enqueue(task("A", 20));
		await enqueue(task("B", 1));
		expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
	});

	it("keeps the lock releasing after a task throws (later tasks still run)", async () => {
		const errors: unknown[] = [];
		const enqueue = createSerialQueue((e) => errors.push(e));
		const ran: string[] = [];
		enqueue(async () => {
			throw new Error("boom");
		});
		await enqueue(async () => {
			ran.push("after");
		});
		expect(ran).toEqual(["after"]);
		expect(errors).toHaveLength(1);
	});

	it("an idle queue accepts new work (tail is just a resolved promise)", async () => {
		const enqueue = createSerialQueue();
		const ran: string[] = [];
		await enqueue(async () => {
			ran.push("first");
		});
		await enqueue(async () => {
			ran.push("second");
		});
		expect(ran).toEqual(["first", "second"]);
	});
});
