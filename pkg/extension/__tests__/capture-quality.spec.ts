/**
 * Tests for lib/capture-quality.ts — the capture size and encoder settings that keep
 * recorded UI text legible.
 *
 * The load-bearing rules: ask tab capture for a size (it defaults to 720p), never send
 * minWidth/minHeight (Chrome would letterbox), and prefer VP9 over the VP8 that a bare
 * "video/webm" resolves to. Since the preset table is the whole point of this module,
 * the table itself is asserted too — a bad row would silently cap every recording.
 */

import { describe, expect, it } from "bun:test";
import {
	CAPTURE_FPS,
	CODEC_LADDER,
	DEFAULT_VIDEO_QUALITY,
	getVideoQuality,
	preferredMimeType,
	presetFor,
	QUALITY_PRESETS,
	type QualityPreset,
	recorderOptions,
	tabCaptureConstraints,
	VIDEO_QUALITIES,
	videoBitrateFor,
} from "@/lib/capture-quality";

/** The legacy tab-capture constraint shape, which lib.dom's types don't describe. */
type Mandatory = {
	chromeMediaSource: string;
	chromeMediaSourceId: string;
	maxWidth?: number;
	maxHeight?: number;
	maxFrameRate?: number;
	minWidth?: number;
	minHeight?: number;
};

const p1080 = QUALITY_PRESETS["1080p"];
const p2160 = QUALITY_PRESETS["2160p"];

const mandatoryOf = (
	streamId: string,
	preset: QualityPreset = p1080,
): Mandatory =>
	(
		tabCaptureConstraints(streamId, preset).video as unknown as {
			mandatory: Mandatory;
		}
	).mandatory;

describe("QUALITY_PRESETS", () => {
	it("covers every advertised quality, so a dropdown choice can never miss", () => {
		for (const quality of VIDEO_QUALITIES)
			expect(QUALITY_PRESETS[quality]).toBeDefined();
		expect(Object.keys(QUALITY_PRESETS)).toHaveLength(VIDEO_QUALITIES.length);
	});

	it("lists qualities smallest first, which is the order the settings dropdown shows", () => {
		const widths = VIDEO_QUALITIES.map((q) => QUALITY_PRESETS[q].width);

		expect(widths).toEqual([...widths].sort((a, b) => a - b));
	});

	it("names each preset's own resolution, so its label cannot drift from its rows", () => {
		for (const quality of VIDEO_QUALITIES)
			expect(QUALITY_PRESETS[quality].label).toContain(quality);
	});

	it("gives a bigger preset a bigger bitrate ceiling", () => {
		const ceilings = VIDEO_QUALITIES.map((q) => QUALITY_PRESETS[q].maxBitrate);

		expect(ceilings).toEqual([...ceilings].sort((a, b) => a - b));
	});

	// A preset below 1280x720 would be worse than the default it exists to override.
	it("never drops below the 720p floor Chrome would have given us anyway", () => {
		for (const quality of VIDEO_QUALITIES) {
			expect(QUALITY_PRESETS[quality].width).toBeGreaterThanOrEqual(1280);
			expect(QUALITY_PRESETS[quality].height).toBeGreaterThanOrEqual(720);
		}
	});

	it("offers a 4K preset, which is the ceiling this work exists to unlock", () => {
		expect(p2160.width).toBe(3840);
		expect(p2160.height).toBe(2160);
	});
});

describe("getVideoQuality", () => {
	it("keeps every advertised quality", () => {
		for (const quality of VIDEO_QUALITIES)
			expect(getVideoQuality(quality)).toBe(quality);
	});

	it("falls back to the default for an unknown or missing value", () => {
		expect(getVideoQuality("4320p")).toBe(DEFAULT_VIDEO_QUALITY);
		expect(getVideoQuality("")).toBe(DEFAULT_VIDEO_QUALITY);
		expect(getVideoQuality(undefined)).toBe(DEFAULT_VIDEO_QUALITY);
	});

	it("defaults to a preset that actually exists", () => {
		expect(QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY]).toBeDefined();
	});
});

describe("presetFor", () => {
	it("resolves a quality name to its row", () => {
		expect(presetFor("2160p")).toBe(p2160);
	});

	// It reads untrusted message data, so a junk value must not index the table blindly.
	it("resolves junk to the default preset rather than undefined", () => {
		expect(presetFor("not-a-quality")).toBe(
			QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY],
		);
		expect(presetFor(undefined)).toBe(QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY]);
	});
});

describe("tabCaptureConstraints", () => {
	it("targets the stream id as a tab source with audio off", () => {
		const m = mandatoryOf("stream-abc");

		expect(m.chromeMediaSource).toBe("tab");
		expect(m.chromeMediaSourceId).toBe("stream-abc");
		expect(tabCaptureConstraints("stream-abc", p1080).audio).toBe(false);
	});

	// Omitting these is what pinned capture to 1280x720 and made small text mush.
	it("requests an explicit frame ceiling rather than accepting the 720p default", () => {
		const m = mandatoryOf("s");

		expect(m.maxWidth).toBe(p1080.width);
		expect(m.maxHeight).toBe(p1080.height);
		expect(m.maxWidth).toBeGreaterThan(1280);
		expect(m.maxHeight).toBeGreaterThan(720);
	});

	it("takes its ceiling from the preset it was handed, not a module constant", () => {
		const m = mandatoryOf("s", p2160);

		expect(m.maxWidth).toBe(3840);
		expect(m.maxHeight).toBe(2160);
	});

	it("caps the frame rate so bits go to detail instead of motion", () => {
		expect(mandatoryOf("s").maxFrameRate).toBe(CAPTURE_FPS);
	});

	/**
	 * A minimum would make Chrome pad or upscale a smaller window to fill the box,
	 * so a modest window records letterboxed instead of small and sharp.
	 */
	it("sets no frame minimum at any preset, so a small window is not letterboxed", () => {
		for (const quality of VIDEO_QUALITIES) {
			const m = mandatoryOf("s", QUALITY_PRESETS[quality]);

			expect(m.minWidth).toBeUndefined();
			expect(m.minHeight).toBeUndefined();
		}
	});
});

describe("videoBitrateFor", () => {
	it("scales with pixel count", () => {
		expect(videoBitrateFor(2560, 1440, p2160)).toBeGreaterThan(
			videoBitrateFor(1280, 720, p2160),
		);
	});

	it("beats MediaRecorder's ~2.5 Mbps default at 1080p", () => {
		expect(videoBitrateFor(1920, 1080, p1080)).toBeGreaterThan(2_500_000);
	});

	it("never drops below the floor for a tiny capture", () => {
		expect(videoBitrateFor(320, 240, p1080)).toBe(2_500_000);
	});

	/**
	 * The same frame gets a different budget per preset: 1080p's ceiling binds and
	 * throttles it, while 2160p's is headroom the computed target stays under.
	 */
	it("clamps to the chosen preset's ceiling, not a single global one", () => {
		expect(videoBitrateFor(3840, 2160, p1080)).toBe(p1080.maxBitrate);
		expect(videoBitrateFor(3840, 2160, p2160)).toBeGreaterThan(
			p1080.maxBitrate,
		);
		expect(videoBitrateFor(3840, 2160, p2160)).toBeLessThanOrEqual(
			p2160.maxBitrate,
		);
	});

	/**
	 * The 4K ceiling used to be what a base64 data URL could survive crossing the
	 * message bus. The video is a Blob in IndexedDB now, so a bigger preset really does
	 * get a bigger budget instead of being quietly clamped back to the old limit.
	 */
	it("lets a 4K preset spend more than the old 10 Mbps transport limit", () => {
		expect(videoBitrateFor(3840, 2160, p2160)).toBeGreaterThan(10_000_000);
	});

	// getSettings() can come back empty; assuming 1080p beats falling to the floor.
	it("assumes 1080p when the track reports no size", () => {
		expect(videoBitrateFor(undefined, undefined, p1080)).toBe(
			videoBitrateFor(1920, 1080, p1080),
		);
		expect(videoBitrateFor(0, 0, p1080)).toBe(
			videoBitrateFor(1920, 1080, p1080),
		);
	});
});

describe("preferredMimeType", () => {
	it("picks VP9 when available — the whole point of the ladder", () => {
		expect(preferredMimeType(true, () => true)).toBe(
			"video/webm;codecs=vp9,opus",
		);
	});

	it("offers the ladder's codecs in order, sharpest first", () => {
		const offered: string[] = [];
		preferredMimeType(false, (type) => {
			offered.push(type);
			return false;
		});

		expect(offered).toEqual([
			...CODEC_LADDER.map((c) => `video/webm;codecs=${c}`),
			"video/webm",
		]);
	});

	it("omits the audio codec for a silent capture", () => {
		expect(preferredMimeType(false, () => true)).toBe("video/webm;codecs=vp9");
	});

	it("falls back to VP8 when VP9 is unsupported", () => {
		const isSupported = (type: string) => !type.includes("vp9");

		expect(preferredMimeType(true, isSupported)).toBe(
			"video/webm;codecs=vp8,opus",
		);
	});

	it("falls back to the bare container when no codec string is supported", () => {
		const isSupported = (type: string) => !type.includes("codecs");

		expect(preferredMimeType(true, isSupported)).toBe("video/webm");
	});

	it("returns undefined when nothing is supported, leaving the choice to MediaRecorder", () => {
		expect(preferredMimeType(true, () => false)).toBeUndefined();
	});
});

describe("recorderOptions", () => {
	it("always carries an explicit bitrate, never MediaRecorder's default", () => {
		expect(recorderOptions(true, 1920, 1080, p1080).videoBitsPerSecond).toBe(
			videoBitrateFor(1920, 1080, p1080),
		);
	});

	it("encodes a 4K capture at the 4K preset's budget", () => {
		expect(recorderOptions(true, 3840, 2160, p2160).videoBitsPerSecond).toBe(
			videoBitrateFor(3840, 2160, p2160),
		);
	});

	// Same frame, different preset: the preset is what decides, not the frame size.
	it("gives the same 4K frame a bigger budget under 2160p than under 1080p", () => {
		const at1080 = recorderOptions(true, 3840, 2160, p1080).videoBitsPerSecond;
		const at2160 = recorderOptions(true, 3840, 2160, p2160).videoBitsPerSecond;

		expect(at2160).toBeGreaterThan(at1080 as number);
	});
});
