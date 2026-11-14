import { describe, expect, it } from "bun:test";
import { createConcurrencyLimit } from "../src/concurrency-limit";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createConcurrencyLimit", () => {
	it("runs at most the given number of tasks at once and starts the next when one settles", async () => {
		const limit = createConcurrencyLimit(2);
		const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
		const started: number[] = [];
		const results = gates.map((gate, index) =>
			limit(() => {
				started.push(index);
				return gate.promise;
			}),
		);
		await tick();
		expect(started).toEqual([0, 1]);
		gates[0]?.resolve(10);
		await tick();
		expect(started).toEqual([0, 1, 2]);
		gates[1]?.resolve(11);
		gates[2]?.resolve(12);
		expect(await Promise.all(results)).toEqual([10, 11, 12]);
	});

	it("passes a rejection to the caller and frees the slot", async () => {
		const limit = createConcurrencyLimit(1);
		const failed = limit(() => Promise.reject(new Error("boom")));
		const next = limit(async () => "ran");
		await expect(failed).rejects.toThrow("boom");
		expect(await next).toBe("ran");
	});

	it("frees the slot when a task throws before it returns a promise", async () => {
		const limit = createConcurrencyLimit(1);
		await expect(
			limit(() => {
				throw new Error("sync");
			}),
		).rejects.toThrow("sync");
		expect(await limit(async () => 1)).toBe(1);
	});

	it("hands a freed slot to the waiting task before a new caller can take it", async () => {
		const limit = createConcurrencyLimit(1);
		const gate = deferred<void>();
		let running = 0;
		let peak = 0;
		const task = async () => {
			running += 1;
			peak = Math.max(peak, running);
			await tick();
			running -= 1;
		};
		const first = limit(() => gate.promise);
		const waiting = limit(task);
		gate.resolve();
		await first;
		const late = limit(task);
		await Promise.all([waiting, late]);
		expect(peak).toBe(1);
	});

	it.each([0, -1, 1.5, Number.NaN])("refuses the size %p", (size) => {
		expect(() => createConcurrencyLimit(size)).toThrow("positive integer");
	});
});
