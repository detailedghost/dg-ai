import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_VIDEO_MS, TAIL_GAP_MS, type TourStep } from "@dg/common";
import { chromium } from "playwright-core";
import { clipMs, narrationClips, narrationHolds, synthesize } from "../src/demo/recorder/narrate";
import { ensureNarrationAssets } from "../src/demo/narration-assets";
import { findInstalledChromium } from "../src/utils/find-browser";

setDefaultTimeout(600_000);

const clip = (seconds: number) => ({ sampleRate: 24_000, pcm: new Float32Array(24_000 * seconds) });

describe("narrationHolds", () => {
	test("holds a voiced step for its clip plus the tail and authored dwell", () => {
		const steps: TourStep[] = [{ body: "a", advance: 1000 }, { body: "" }];
		expect(narrationHolds(steps, [clip(2), null])).toEqual([2000 + TAIL_GAP_MS + 1000, DEFAULT_VIDEO_MS]);
	});

	test("reads a clip length in ms", () => {
		expect(clipMs(clip(1.5))).toBe(1500);
	});
});

describe("narrationClips", () => {
	test("places each clip at its caption offset, counted from the trimmed start", () => {
		const clips = narrationClips([clip(1), null, clip(1)], [1500, 4000, 7000], 1000);
		expect(clips.map((c) => c.offsetMs)).toEqual([500, 6000]);
	});
});

const live =
	process.env.PW_E2E === "1" && process.env.DG_NARRATION_E2E === "1" ? findInstalledChromium() : null;

describe("synthesize in a real browser", () => {
	test.skipIf(!live)("returns one 24 kHz clip per narrated text and null for blank text", async () => {
		const assetDir = await ensureNarrationAssets(process.env.DG_NARRATION_VERSION ?? "2.0.1");
		const launched = await chromium.launch({ executablePath: live as string, args: ["--no-sandbox"] });
		try {
			const context = await launched.newContext();
			const clips = await synthesize(context, ["Hello there.", ""], { assetDir });
			expect(clips[0]?.sampleRate).toBe(24_000);
			expect(clips[0]?.pcm.length).toBeGreaterThan(0);
			expect(clips[1]).toBeNull();
		} finally {
			await launched.close();
		}
	});
});
