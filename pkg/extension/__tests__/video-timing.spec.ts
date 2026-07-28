/**
 * Tests for lib/video-timing.ts — how long a step holds during a recorded video.
 *
 * The load-bearing rule: on a narrated step an authored timing is dwell time AFTER
 * the voice finishes, not a floor on the whole step.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_VIDEO_MS, holdFor, TAIL_GAP_MS } from "@/lib/video-timing";

describe("holdFor — narrated steps", () => {
	it("adds the authored timing on top of the narration and its tail", () => {
		expect(holdFor({ advance: 4000 }, 6000)).toBe(6000 + TAIL_GAP_MS + 4000);
	});

	it("holds for narration plus tail when no timing is authored", () => {
		expect(holdFor({}, 6000)).toBe(6000 + TAIL_GAP_MS);
		expect(holdFor({ advance: "next" }, 6000)).toBe(6000 + TAIL_GAP_MS);
		expect(holdFor({ advance: "click" }, 6000)).toBe(6000 + TAIL_GAP_MS);
	});

	it("never lets narration outrunning the timing swallow it (the old max() bug)", () => {
		// 4s authored, 6s narration: max() returned 6.7s and lost the pause entirely.
		const narrationLonger = holdFor({ advance: 4000 }, 6000);
		expect(narrationLonger).toBeGreaterThan(6000 + TAIL_GAP_MS);

		// And the reverse case still waits for the voice rather than cutting it off.
		const timingLonger = holdFor({ advance: 9000 }, 2000);
		expect(timingLonger).toBe(2000 + TAIL_GAP_MS + 9000);
		expect(timingLonger).toBeGreaterThan(9000);
	});

	it("rounds to whole milliseconds for a fractional clip length", () => {
		expect(holdFor({ advance: 1000 }, 2500.4)).toBe(
			Math.round(2500.4 + TAIL_GAP_MS + 1000),
		);
		expect(Number.isInteger(holdFor({}, 1234.56))).toBe(true);
	});

	it("treats a zero-length clip as narrated, so the tail still applies", () => {
		expect(holdFor({ advance: 500 }, 0)).toBe(TAIL_GAP_MS + 500);
	});
});

describe("holdFor — unnarrated steps", () => {
	it("uses the authored timing as the whole hold", () => {
		expect(holdFor({ advance: 4000 }, null)).toBe(4000);
	});

	it("falls back to the default when nothing is authored", () => {
		expect(holdFor({}, null)).toBe(DEFAULT_VIDEO_MS);
		expect(holdFor(undefined, null)).toBe(DEFAULT_VIDEO_MS);
	});

	it("ignores non-numeric advance modes, which carry no duration", () => {
		expect(holdFor({ advance: "next" }, null)).toBe(DEFAULT_VIDEO_MS);
		expect(holdFor({ advance: "click" }, null)).toBe(DEFAULT_VIDEO_MS);
		expect(holdFor({ advance: null }, null)).toBe(DEFAULT_VIDEO_MS);
	});
});
