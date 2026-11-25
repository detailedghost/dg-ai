import { describe, expect, it, mock } from "bun:test";

type Progress = (info: { status: string }) => void;

const captured: { progress?: Progress } = {};

mock.module("kokoro-js", () => ({
	env: {},
	KokoroTTS: {
		from_pretrained: async (_id: string, options: { progress_callback: Progress }) => {
			captured.progress = options.progress_callback;
			return { generate: async () => ({}) };
		},
	},
}));

(globalThis as { chrome?: unknown }).chrome = { runtime: { getURL: (path: string) => `chrome-extension://x/${path}` } };

const { loadKokoro, narrationLoaded } = await import("@/utils/kokoro");

describe("loadKokoro progress listeners", () => {
	it("keeps no listener from a caller that arrives after the model loaded", async () => {
		await loadKokoro(() => undefined);
		await Promise.resolve();
		expect(narrationLoaded()).toBe(true);

		const calls = 5_000;
		let delivered = 0;
		for (let i = 0; i < calls; i++) await loadKokoro(() => void delivered++);
		captured.progress?.({ status: "progress" });

		console.log(`kokoro retained listeners after ${calls} warm calls: ${delivered}`);
		expect(delivered).toBe(0);
	});
});
