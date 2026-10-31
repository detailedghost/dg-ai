import { describe, expect, test } from "bun:test";
import { nextGapMs, timeoutSeconds } from "../src/pace/jitter";

function seq(values: number[]): () => number {
	let index = 0;
	return () => {
		const value = values[index % values.length] ?? 0;
		index += 1;
		return value;
	};
}

describe("nextGapMs", () => {
	test("low, mid, and high rolls land on exact gaps", () => {
		expect(nextGapMs(seq([0, 0]))).toBe(200);
		expect(nextGapMs(seq([0.599, 1]))).toBe(1000);
		expect(nextGapMs(seq([0.599, 0.5]))).toBe(400);
		expect(nextGapMs(seq([0.6, 0]))).toBe(1000);
		expect(nextGapMs(seq([0.899, 0.5]))).toBe(1750);
		expect(nextGapMs(seq([0.9, 0.5]))).toBe(5000);
	});

	test("a repeated gap is nudged so the pace is not a fixed stride", () => {
		expect(nextGapMs(seq([0, 0, 0]), [200])).toBe(337);
		expect(nextGapMs(seq([0.9, 0.5, 0]), [5000])).toBe(5137);
	});

	test("an even stride across three gaps is broken", () => {
		expect(nextGapMs(seq([0.9, 0, 0]), [2000, 2500])).toBe(3089);
		expect(nextGapMs(seq([0.9, 0, 0.5]), [2000, 2500])).toBe(3139);
	});

	test("a stride that is not even stays on the raw gap", () => {
		expect(nextGapMs(seq([0.9, 0, 0]), [2000, 2600])).toBe(3000);
	});

	test("one earlier gap is not a stride", () => {
		expect(nextGapMs(seq([0.9, 0, 0]), [2500])).toBe(3000);
		expect(nextGapMs(seq([0.9, 0, 0]), [])).toBe(3000);
	});

	test("eight draws from a cycling source are not one interval", () => {
		const rng = seq([0.1, 0.2, 0.95, 0.1, 0.7, 0.4]);
		const gaps: number[] = [];
		for (let i = 0; i < 8; i += 1) gaps.push(nextGapMs(rng, gaps));
		expect(new Set(gaps).size).toBeGreaterThan(1);
		const steps = gaps.slice(1).map((gap, index) => gap - (gaps[index] ?? 0));
		expect(new Set(steps).size).toBeGreaterThan(1);
	});
});

describe("timeoutSeconds", () => {
	test("turns a gap into a whole number of seconds that still varies", () => {
		expect(timeoutSeconds(200)).toBe(1);
		expect(timeoutSeconds(1000)).toBe(2);
		expect(timeoutSeconds(5000)).toBe(6);
		expect(timeoutSeconds(200)).not.toBe(timeoutSeconds(5000));
	});
});
