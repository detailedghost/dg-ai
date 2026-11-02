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

export const DEFAULT_NARRATION: NarrationMode = "both";
export const DEFAULT_VOICE = "af_heart";

const VOICE_ACCENTS: Record<string, string> = { a: "American", b: "British" };
const VOICE_GENDERS: Record<string, string> = { f: "female", m: "male" };

/**
 * Turn a Kokoro voice id into something readable: `af_heart` → `Heart — American female`.
 *
 * Derived from the id's prefix rather than a hand-kept map, so a voice added to VOICES
 * gets a proper label for free; an id that doesn't match the convention shows as-is.
 */
export function voiceLabel(voice: string): string {
	const parts = /^([ab])([fm])_(.+)$/.exec(voice);
	if (!parts) return voice;
	const [, accent, gender, name] = parts;
	const proper = name.charAt(0).toUpperCase() + name.slice(1);
	return `${proper} — ${VOICE_ACCENTS[accent]} ${VOICE_GENDERS[gender]}`;
}

export function parseNarrationMode(value: string): NarrationMode {
	return NARRATION_MODES.some((m) => m.value === value)
		? (value as NarrationMode)
		: DEFAULT_NARRATION;
}
