import { describe, expect, it, mock } from "bun:test";

const seen: number[] = [];
let ticks = 0;
let failNext: () => boolean = () => false;

mock.module("../src/narration/kokoro", () => ({
	loadKokoro: async () => ({
		generate: async () => {
			if (failNext()) throw new Error("boom");
			seen.push(ticks);
			return { audio: new Float32Array(2400), sampling_rate: 24_000 };
		},
	}),
}));

const { holdFor } = await import("../src/video-timing");
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

	it("forgets earlier clip lengths when a later step fails to synthesize", async () => {
		let calls = 0;
		failNext = () => ++calls === 2;
		const narrator = createNarrator("https://assets.test/", async () => undefined);
		await expect(
			narrator.prepare([{ body: "one" }, { body: "two" }] as never, "af_heart", () => undefined),
		).rejects.toThrow("boom");
		failNext = () => false;
		expect(narrator.clipMs?.(0)).toBeUndefined();
	});

	it("counts a refused clip as unvoiced and reports narration as partial", async () => {
		const labels: string[] = [];
		const narrator = createNarrator("https://assets.test/", async (msg) =>
			msg.kind === "clip" && msg.index === 1 ? { accepted: false } : { accepted: true },
		);
		const holds = await narrator.prepare(
			[{ body: "one" }, { body: "two" }, { body: "three" }] as never,
			"af_heart",
			(_percent, label) => void labels.push(label),
		);
		expect(narrator.clipMs?.(0)).toBe(100);
		expect(narrator.clipMs?.(1)).toBeUndefined();
		expect(narrator.clipMs?.(2)).toBe(100);
		expect(holds[1]).toBe(holdFor({ body: "two" } as never, null));
		expect(labels).not.toContain("Narration ready");
		expect(labels.at(-1)).toBe("Narration partial: 2 of 3 steps voiced");
	});

	it("reports narration ready when every clip is accepted", async () => {
		const labels: string[] = [];
		const narrator = createNarrator("https://assets.test/", async () => ({ accepted: true }));
		await narrator.prepare([{ body: "one" }] as never, "af_heart", (_p, label) => void labels.push(label));
		expect(labels.at(-1)).toBe("Narration ready");
	});
});
