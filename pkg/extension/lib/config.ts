import { browser } from "wxt/browser";
import {
	DEFAULT_VIDEO_QUALITY,
	type VideoQuality,
} from "@/lib/capture-quality";
import { type ConfigRelayReply, MSG } from "@/lib/chat-messages";

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
	videoQuality: VideoQuality;
};

export const DEFAULTS: Config = {
	color: "random",
	voice: "af_heart",
	narration: "both",
	videoQuality: DEFAULT_VIDEO_QUALITY,
};

// Kokoro ids encode origin and gender as a prefix: <a|b><f|m>_<name>.
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

/** Coerce an untrusted string (a stored value or a form input) to a NarrationMode. */
export function getNarrationMode(val: string): NarrationMode {
	return NARRATION_MODES.some((m) => m.value === val)
		? (val as NarrationMode)
		: DEFAULTS.narration;
}

/** The settings-page label for a mode, for read-only display elsewhere. */
export function narrationModeLabel(mode: NarrationMode): string {
	return (
		NARRATION_MODES.find((m) => m.value === mode)?.label ?? DEFAULTS.narration
	);
}

export async function getConfig(): Promise<Config> {
	return (await browser.storage.sync.get(DEFAULTS)) as Config;
}

export async function setConfig(cfg: Config): Promise<void> {
	await browser.storage.sync.set(cfg);
}

/**
 * Change some fields, re-reading the stored config first so the rest survive.
 *
 * Use this instead of spreading a config a caller is already holding: a long-lived
 * panel's snapshot goes stale the moment the settings page saves, so writing it back
 * wholesale silently reverts whatever else the user changed.
 */
export async function patchConfig(patch: Partial<Config>): Promise<void> {
	await setConfig({ ...(await getConfig()), ...patch });
}

/**
 * The configured recording mode, falling back to the default if sync storage
 * can't be read.
 *
 * The callers are display paths that have to render regardless: a rejected read
 * used to abort the entire "press to record" prompt, leaving the user no visible
 * way to start a recording at all.
 */
export async function readNarrationMode(): Promise<NarrationMode> {
	try {
		return getNarrationMode((await getConfig()).narration);
	} catch (e) {
		console.warn("[dg-ai-extension] narration mode read failed", e);
		return DEFAULTS.narration;
	}
}

export const ASSET_DIRECTORY_CONFIG_KEY = "assetDirectory";

export type ConfigFrameReply = { value?: unknown; error?: string };
export type ConfigFrameRequest = {
	type: "config-get" | "config-set";
	key: string;
	value?: string;
};
export type SendConfigFrame = (
	frame: ConfigFrameRequest,
) => Promise<ConfigFrameReply>;

export type AssetDirectoryLoadResult =
	| { status: "ok"; value: string }
	| { status: "unavailable" };
export type AssetDirectorySaveResult =
	| { ok: true }
	| { ok: false; error: string };

export type ConfigTransport = {
	getAssetDirectory(): Promise<AssetDirectoryLoadResult>;
	setAssetDirectory(value: string): Promise<AssetDirectorySaveResult>;
};

export function createDaemonConfigTransport(seams: {
	sendConfigFrame: SendConfigFrame;
}): ConfigTransport {
	return {
		async getAssetDirectory() {
			try {
				const reply = await seams.sendConfigFrame({
					type: "config-get",
					key: ASSET_DIRECTORY_CONFIG_KEY,
				});
				if (reply.error !== undefined || typeof reply.value !== "string") {
					return { status: "unavailable" };
				}
				return { status: "ok", value: reply.value };
			} catch {
				return { status: "unavailable" };
			}
		},
		async setAssetDirectory(value: string) {
			try {
				const reply = await seams.sendConfigFrame({
					type: "config-set",
					key: ASSET_DIRECTORY_CONFIG_KEY,
					value,
				});
				if (reply.error !== undefined) {
					return { ok: false, error: reply.error };
				}
				return { ok: true };
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
	};
}

type ConfigRelayRuntime = { sendMessage(message: unknown): Promise<unknown> };

export function createLiveAssetDirectoryTransport(): ConfigTransport {
	const runtime = browser.runtime as unknown as ConfigRelayRuntime;
	return createDaemonConfigTransport({
		sendConfigFrame: async (frame) => {
			const response = await runtime.sendMessage({
				type: MSG.configRequest,
				request: frame.type,
				key: frame.key,
				...(frame.value === undefined ? {} : { value: frame.value }),
			});
			if (typeof response !== "object" || response === null) {
				throw new Error("the background relay did not answer");
			}
			const reply = response as Partial<ConfigRelayReply>;
			if (reply.key !== frame.key) {
				throw new Error("the background relay answered a different config key");
			}
			return {
				value: reply.value,
				error: typeof reply.error === "string" ? reply.error : undefined,
			};
		},
	});
}
