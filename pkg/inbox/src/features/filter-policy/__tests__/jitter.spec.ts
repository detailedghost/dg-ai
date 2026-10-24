import { describe, expect, test } from "bun:test";
import {
	adjustGap,
	nextBackoffMs,
	nextBurstBudget,
	nextGapMs,
	nextIdleBreakMs,
	ProtonGate,
	protonPaceClass,
	runPaced,
	type Clock,
} from "../jitter";

function scripted(values: number[]): () => number {
	let index = 0;
	return () => values[index++] ?? 0;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

describe("proton pacing", () => {
	test("mixes a heavy tail and breaks a repeated gap", () => {
		expect(nextGapMs(scripted([0, 0]))).toBe(320);
		expect(nextGapMs(scripted([0.63, 0]))).toBe(1100);
		expect(nextGapMs(scripted([0.91, 0]))).toBe(3200);
		expect(nextGapMs(scripted([0.91, 1]))).toBe(8200);
		expect(nextIdleBreakMs(scripted([0, 0]))).toBe(4500);
		expect(nextIdleBreakMs(scripted([0.79, 1]))).toBe(32000);
		expect(nextBackoffMs(scripted([0, 0]), 1, "rate-limit")).toBe(2000 + 1500);
		expect(nextBackoffMs(scripted([0.71, 1]), 2, "rate-limit")).toBe(
			2000 + 3000 + 7000 + 4000,
		);
		expect(nextBackoffMs(scripted([0, 0]), 1, "transient")).toBe(800 + 600);
		expect(nextBurstBudget(scripted([0]))).toBe(2);
		expect(nextBurstBudget(scripted([0.5]))).toBe(3);
		expect(nextBurstBudget(scripted([0.8]))).toBe(4);
		expect(nextBurstBudget(scripted([0.9]))).toBe(5);
		expect(adjustGap(349, [280], () => 0)).toBe(419);
		expect(adjustGap(350, [280], () => 0)).toBe(350);
		expect(adjustGap(3680, [280, 1980], () => 0)).toBe(3793);
		expect(adjustGap(3681, [280, 1980], () => 0)).toBe(3681);
		expect(adjustGap(280, [], () => 0)).toBe(280);
		const gaps = [nextGapMs(scripted([0, 0]))];
		gaps.push(nextGapMs(scripted([0, 0, 0]), gaps));
		expect(gaps[1]).not.toBe(gaps[0]);
	});

	test("draws irregular gaps with no fixed step and no constant percentage", () => {
		const rng = mulberry32(0x51f00d);
		const gaps: number[] = [];
		for (let index = 0; index < 48; index += 1) {
			gaps.push(nextGapMs(rng, gaps));
		}
		expect(new Set(gaps).size).toBeGreaterThan(20);
		const diffs = gaps.slice(1).map((gap, index) => gap - gaps[index]!);
		expect(diffs.every((diff) => diff === diffs[0])).toBe(false);
		const ratios = gaps.slice(1).map((gap, index) => gap / gaps[index]!);
		expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.5);
		const sorted = [...gaps].sort((left, right) => left - right);
		const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		expect(sorted.at(-1) ?? 0).toBeGreaterThan(median * 3);
		expect(protonPaceClass(new Error("failed (HTTP 429; http-failure)"))).toBe(
			"rate-limit",
		);
		expect(protonPaceClass(new Error("failed (HTTP 503; http-failure)"))).toBe(
			"transient",
		);
		expect(protonPaceClass(new Error("failed (HTTP 400; http-failure)"))).toBe(
			"stop",
		);
		expect(protonPaceClass(new Error("Proton request timed out. (timeout)"))).toBe(
			"transient",
		);
		expect(protonPaceClass(new Error("Sign in to Proton Mail. (auth-expired)"))).toBe(
			"stop",
		);
	});

	test("sleeps between calls, inserts a longer break, and never overlaps", async () => {
		const sleeps: number[] = [];
		const clock: Clock = {
			now: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		};
		const gate = new ProtonGate(clock, () => 0.1, 2);
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			[0, 1, 2, 3].map((value) =>
				gate.run(async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await Promise.resolve();
					active -= 1;
					return value;
				}),
			),
		);
		expect(maxActive).toBe(1);
		expect(sleeps).toHaveLength(3);
		expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(4500);
		expect(new Set(sleeps).size).toBeGreaterThan(1);
		const diffs = sleeps.slice(1).map((gap, index) => gap - sleeps[index]!);
		expect(diffs.every((diff) => diff === diffs[0])).toBe(false);
		expect(await runPaced([], clock, Math.random)).toEqual([]);
	});

	test("backs off a rate limit, then stops, and does not retry a rejected write", async () => {
		const sleeps: number[] = [];
		const clock: Clock = {
			now: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		};
		const gate = new ProtonGate(clock, () => 0.1, 5);
		let reads = 0;
		await expect(
			gate.run(
				async () => {
					reads += 1;
					throw new Error("Proton API request failed. (HTTP 429; http-failure)");
				},
				{ retry: true },
			),
		).rejects.toThrow(/429/);
		expect(reads).toBe(3);
		expect(sleeps).toHaveLength(2);
		expect(sleeps[0]).not.toBe(sleeps[1]);
		let writes = 0;
		await expect(
			gate.run(async () => {
				writes += 1;
				throw new Error("Proton API request failed. (HTTP 429; http-failure)");
			}),
		).rejects.toThrow(/429/);
		expect(writes).toBe(1);
		let transient = 0;
		await expect(
			gate.run(
				async () => {
					transient += 1;
					throw new Error("Proton request timed out. (timeout)");
				},
				{ retry: true },
			),
		).rejects.toThrow(/timed out/);
		expect(transient).toBe(2);
	});
});
