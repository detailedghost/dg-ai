import { describe, expect, test } from "bun:test";
import { adjustGap, nextWriteGapMs, runPaced, type Clock } from "../jitter";

function scripted(values: number[]): () => number {
	let index = 0;
	return () => values[index++] ?? 0;
}

describe("proton write pacing", () => {
	test("uses a non-uniform gap and breaks equal or steady rhythms", () => {
		expect(nextWriteGapMs(scripted([0, 0]))).toBe(280);
		expect(nextWriteGapMs(scripted([0.83, 0]))).toBe(2200);
		expect(nextWriteGapMs(scripted([0.82, 1]))).toBe(280 + 1700);
		expect(adjustGap(349, [280], () => 0)).toBe(419);
		expect(adjustGap(350, [280], () => 0)).toBe(350);
		expect(adjustGap(3680, [280, 1980], () => 0)).toBe(3793);
		expect(adjustGap(3681, [280, 1980], () => 0)).toBe(3681);
		expect(adjustGap(280, [], () => 0)).toBe(280);
		const gaps = [nextWriteGapMs(scripted([0, 0]))];
		gaps.push(nextWriteGapMs(scripted([0, 0, 0]), gaps));
		expect(gaps[1]).not.toBe(gaps[0]);
	});

	test("sleeps between writes and not before the first", async () => {
		const sleeps: number[] = [];
		const clock: Clock = {
			now: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		};
		const order: string[] = [];
		const results = await runPaced(
			[
				async () => {
					order.push("a");
					return "a";
				},
				async () => {
					order.push("b");
					return "b";
				},
			],
			clock,
			scripted([0.2, 0.4, 0.1, 0.9]),
		);
		expect(results).toEqual(["a", "b"]);
		expect(order).toEqual(["a", "b"]);
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThan(0);
		expect(await runPaced([], clock, Math.random)).toEqual([]);
	});
});
