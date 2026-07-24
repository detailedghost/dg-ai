import { describe, expect, it } from "bun:test";
import { NarrationProgressTracker } from "@/lib/narration-progress";

describe("NarrationProgressTracker", () => {
	it("aggregates model bytes and never moves backwards", () => {
		const tracker = new NarrationProgressTracker();

		expect(
			tracker.model({
				status: "progress",
				file: "model.onnx",
				loaded: 25,
				total: 100,
			}),
		).toBe(25);
		expect(
			tracker.model({
				status: "progress",
				file: "voices.bin",
				loaded: 0,
				total: 100,
			}),
		).toBe(25);
		expect(
			tracker.model({
				status: "progress",
				file: "model.onnx",
				loaded: 100,
				total: 100,
			}),
		).toBe(50);
	});

	it("allocates the remaining progress to synthesis and completion", () => {
		const tracker = new NarrationProgressTracker();

		expect(tracker.modelReady()).toBe(60);
		expect(tracker.synthesis(1, 2)).toBe(79);
		expect(tracker.synthesis(2, 2)).toBe(98);
		expect(tracker.ready()).toBe(100);
	});

	it("handles narration with no spoken steps", () => {
		const tracker = new NarrationProgressTracker();

		expect(tracker.synthesis(0, 0)).toBe(98);
		expect(tracker.ready()).toBe(100);
	});
});
