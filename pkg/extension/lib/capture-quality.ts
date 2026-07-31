/**
 * Capture resolution and encoder settings for recorded demo tours.
 *
 * Neither half of the pipeline defaults to anything usable for a screen recording of
 * UI: Chrome's tab capture caps itself at 1280x720 when asked for no particular size,
 * and a MediaRecorder handed a bare "video/webm" encodes VP8 at roughly 2.5 Mbps. A
 * downscale followed by the weakest codec at a low bitrate is what turns small
 * on-screen text into mush, and both have to be overridden explicitly — there is no
 * "record this properly" flag to set.
 *
 * Everything that decides how sharp a recording is lives in `QUALITY_PRESETS` and
 * `CODEC_LADDER`, so raising the ceiling is a one-line edit here rather than a change
 * to the recorder.
 */

/**
 * The presets a user can choose between, smallest first.
 *
 * Declared as an array rather than a bare union so the type, the settings dropdown's
 * order, and the coercer all read from one place.
 */
export const VIDEO_QUALITIES = ["720p", "1080p", "1440p", "2160p"] as const;

export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/** Balanced default: native on a common laptop display, at a sane file size. */
export const DEFAULT_VIDEO_QUALITY: VideoQuality = "1080p";

/**
 * Codec ladder, sharpest first. Add a codec here and every preset picks it up.
 *
 * VP9 is the entire point of it: at equal bitrate it holds small text far better than
 * the VP8 that a bare "video/webm" resolves to.
 */
export const CODEC_LADDER = ["vp9", "vp8"] as const;

export type QualityPreset = {
	label: string;
	/** Ceiling on the captured frame, in device pixels. */
	width: number;
	height: number;
	/**
	 * Bits per pixel per frame targeted by the encoder.
	 *
	 * ~0.08 is around the point VP9 stops visibly degrading text on screen content. It
	 * behaves as a ceiling for the busy moments rather than a size the whole file pays,
	 * since a mostly-static UI frame costs the encoder far less than the budget allows.
	 */
	bpp: number;
	/** Cap on the computed bitrate, which is what really decides the file size. */
	maxBitrate: number;
};

/**
 * Resolution, bitrate budget, and label per preset.
 *
 * Capture comes out at min(tab viewport, preset) with the aspect ratio preserved, so a
 * 1080p window records at its native size under any preset rather than being upscaled.
 * These ceilings are about file size and encode cost only: the finished video reaches
 * the downloader as a Blob through IndexedDB, so no message-size limit constrains them.
 */
export const QUALITY_PRESETS: Record<VideoQuality, QualityPreset> = {
	"720p": {
		label: "720p — smallest file",
		width: 1280,
		height: 720,
		bpp: 0.08,
		maxBitrate: 4_000_000,
	},
	"1080p": {
		label: "1080p — balanced",
		width: 1920,
		height: 1080,
		bpp: 0.08,
		maxBitrate: 8_000_000,
	},
	"1440p": {
		label: "1440p — sharp",
		width: 2560,
		height: 1440,
		bpp: 0.08,
		maxBitrate: 14_000_000,
	},
	"2160p": {
		label: "2160p — sharpest, very large files",
		width: 3840,
		height: 2160,
		bpp: 0.1,
		maxBitrate: 30_000_000,
	},
};

/** Frame-rate cap. A tour is a UI walkthrough, not motion, so bits belong in detail. */
export const CAPTURE_FPS = 30;

/** Floor, so a tiny capture never encodes worse than MediaRecorder's own default. */
const MIN_VIDEO_BITRATE = 2_500_000;

/** Frame size assumed when a capture track will not report its own settings. */
const ASSUMED_WIDTH = 1920;
const ASSUMED_HEIGHT = 1080;

/**
 * Coerce an untrusted value — a stored setting, a form input, a message field — to a
 * known preset name.
 */
export function getVideoQuality(val: string | undefined): VideoQuality {
	return VIDEO_QUALITIES.some((q) => q === val)
		? (val as VideoQuality)
		: DEFAULT_VIDEO_QUALITY;
}

/** The preset for an untrusted quality name, falling back to the default. */
export function presetFor(quality: string | undefined): QualityPreset {
	return QUALITY_PRESETS[getVideoQuality(quality)];
}

/**
 * getUserMedia constraints that capture `streamId` at `preset`'s size instead of 720p.
 *
 * Only maxima are set. Adding minWidth/minHeight would have Chrome letterbox or upscale
 * the tab to fill the requested box; leaving them off lets a small window record small
 * and honest.
 */
export function tabCaptureConstraints(
	streamId: string,
	preset: QualityPreset,
): MediaStreamConstraints {
	return {
		audio: false,
		// Non-standard tab-capture constraint shape — not in lib.dom types.
		video: {
			mandatory: {
				chromeMediaSource: "tab",
				chromeMediaSourceId: streamId,
				maxWidth: preset.width,
				maxHeight: preset.height,
				maxFrameRate: CAPTURE_FPS,
			},
		} as unknown as MediaTrackConstraints,
	};
}

/** Target video bitrate for a `width`x`height` frame, clamped to `preset`'s band. */
export function videoBitrateFor(
	width: number | undefined,
	height: number | undefined,
	preset: QualityPreset,
	fps: number = CAPTURE_FPS,
): number {
	const w = width && width > 0 ? width : ASSUMED_WIDTH;
	const h = height && height > 0 ? height : ASSUMED_HEIGHT;
	const target = w * h * fps * preset.bpp;
	return Math.round(
		Math.min(preset.maxBitrate, Math.max(MIN_VIDEO_BITRATE, target)),
	);
}

/** `MediaRecorder.isTypeSupported`, injectable so the codec ladder stays testable. */
export type TypeSupportCheck = (type: string) => boolean;

const nativeTypeSupport: TypeSupportCheck = (type) =>
	typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type);

/**
 * The sharpest webm profile this build will actually encode, or undefined to leave the
 * choice to MediaRecorder.
 *
 * The codec string tracks whether narration is mixed in, because naming a codec for a
 * track the stream does not have is not worth trusting Chrome to forgive.
 */
export function preferredMimeType(
	hasAudio: boolean,
	isSupported: TypeSupportCheck = nativeTypeSupport,
): string | undefined {
	const audio = hasAudio ? ",opus" : "";
	return [
		...CODEC_LADDER.map((codec) => `video/webm;codecs=${codec}${audio}`),
		"video/webm",
	].find((type) => isSupported(type));
}

/** MediaRecorder options for a mixed tour stream captured at `width`x`height`. */
export function recorderOptions(
	hasAudio: boolean,
	width: number | undefined,
	height: number | undefined,
	preset: QualityPreset,
): MediaRecorderOptions {
	const mimeType = preferredMimeType(hasAudio);
	return {
		...(mimeType ? { mimeType } : {}),
		videoBitsPerSecond: videoBitrateFor(width, height, preset),
	};
}
