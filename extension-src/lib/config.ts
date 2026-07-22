import { browser } from "wxt/browser";

/** The nine tab-group colors Chrome/Firefox accept. */
export type GroupColor =
	| "grey"
	| "blue"
	| "red"
	| "yellow"
	| "green"
	| "pink"
	| "purple"
	| "cyan"
	| "orange";

export const GROUP_COLORS: GroupColor[] = [
	"grey",
	"blue",
	"red",
	"yellow",
	"green",
	"pink",
	"purple",
	"cyan",
	"orange",
];

/** Configured color, or "random" to pick a fresh color per new group. */
export type ColorSetting = GroupColor | "random";

/** Resolve the color setting to a concrete color ("random" → a random one). */
export function resolveColor(c: ColorSetting): GroupColor {
	if (c !== "random") return c;
	return GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
}

// A curated subset of Kokoro voices for the settings dropdown (grade A/B first).
export const VOICES = [
	"af_heart",
	"af_bella",
	"af_nicole",
	"af_sarah",
	"af_sky",
	"am_michael",
	"am_fenrir",
	"am_puck",
	"am_adam",
	"bf_emma",
	"bf_isabella",
	"bm_george",
	"bm_fable",
] as const;

/**
 * Demo-recording narration mode:
 * - "both"     — spoken voiceover + the on-screen text box (default)
 * - "voice"    — voiceover only; the body text is spoken, not boxed (cleaner video)
 * - "captions" — silent; on-screen text box only (skips Kokoro entirely)
 */
export type NarrationMode = "both" | "voice" | "captions";
export const NARRATION_MODES: { value: NarrationMode; label: string }[] = [
	{ value: "both", label: "Voiceover + captions" },
	{ value: "voice", label: "Voiceover only" },
	{ value: "captions", label: "Captions only (silent)" },
];

// Group name is per-invocation (from the URL marker); color + demo-narration are configured.
export type Config = {
	color: ColorSetting;
	voice: string;
	narration: NarrationMode;
};

export const DEFAULTS: Config = {
	color: "random",
	voice: "af_heart",
	narration: "both",
};

export async function getConfig(): Promise<Config> {
	return (await browser.storage.sync.get(DEFAULTS)) as Config;
}

export async function setConfig(cfg: Config): Promise<void> {
	await browser.storage.sync.set(cfg);
}
