import { describe, expect, it, mock } from "bun:test";

const seen: number[] = [];
let ticks = 0;

mock.module("../src/narration/kokoro", () => ({
	loadKokoro: async () => ({
		generate: async () => {
			seen.push(ticks);
			return { audio: new Float32Array(2400), sampling_rate: 24_000 };
		},
	}),
}));

const { createNarrator } = await import("../src/narration/narrate");

describe("createNarrator", () => {
	it("yields to the event loop between clips so the page can repaint progress", async () => {
		const timer = setInterval(() => {
			ticks++;
		}, 0);
		const narrator = createNarrator("https://assets.test/", async () => undefined);
		await narrator.prepare(
			[{ body: "one" }, { body: "two" }, { body: "three" }] as never,
			"af_heart",
			() => undefined,
		);
		clearInterval(timer);
		expect(seen).toHaveLength(3);
		expect(seen[1]).toBeGreaterThan(seen[0] ?? 0);
		expect(seen[2]).toBeGreaterThan(seen[1] ?? 0);
	});

	it("reports each clip length from its samples and sample rate", async () => {
		const narrator = createNarrator("https://assets.test/", async () => undefined);
		await narrator.prepare(
			[{ body: "one" }, { title: "silent" }, { body: "three" }] as never,
			"af_heart",
			() => undefined,
		);
		expect(narrator.clipMs?.(0)).toBe(100);
		expect(narrator.clipMs?.(1)).toBeUndefined();
		expect(narrator.clipMs?.(2)).toBe(100);
	});
});
