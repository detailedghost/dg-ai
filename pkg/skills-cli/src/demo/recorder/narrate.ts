import { holdFor, NARRATION_ASSET_BASE, type TourStep } from "@dg/common";
import type { BrowserContext, Route } from "playwright-core";
import { serveNarrationAsset } from "../narration-assets";
import type { Clip } from "../narration";

export const DEFAULT_VOICE = "af_heart";

export type SpokenClip = { sampleRate: number; pcm: Float32Array };

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const ORIGIN = new URL(NARRATION_ASSET_BASE).origin;

export const clipMs = (clip: SpokenClip): number => Math.round((clip.pcm.length * 1000) / clip.sampleRate);

/** Each step's hold: clip length plus tail and authored dwell when voiced, else the silent hold. */
export function narrationHolds(steps: TourStep[], clips: (SpokenClip | null)[]): number[] {
	return steps.map((step, i) => {
		const spoken = clips[i];
		return holdFor(step, spoken ? clipMs(spoken) : null);
	});
}

/** Clips placed at their caption offsets, counted from the trimmed start of the video. */
export function narrationClips(
	clips: (SpokenClip | null)[],
	offsets: number[],
	startMs: number,
): Clip[] {
	return clips.flatMap((spoken, i) =>
		spoken ? [{ ...spoken, offsetMs: Math.max(0, (offsets[i] ?? 0) - startMs) }] : [],
	);
}

/**
 * Speak each text with Kokoro in a page on the routed demo origin, which carries no site CSP.
 * Blank text yields null.
 */
export async function synthesize(
	context: BrowserContext,
	texts: string[],
	options: { assetDir: string; voice?: string },
): Promise<(SpokenClip | null)[]> {
	const page = await context.newPage();
	try {
		await page.route(`${ORIGIN}/**`, async (route: Route) => {
			const { pathname } = new URL(route.request().url());
			if (pathname === "/")
				return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>narrator</title>" });
			const asset = serveNarrationAsset(options.assetDir, pathname);
			return route.fulfill({ status: asset.status, headers: asset.headers, body: asset.body });
		});
		await page.goto(`${ORIGIN}/`);
		const encoded = await page.evaluate(
			async ({ base, texts, voice, model }) => {
				type Kokoro = {
					KokoroTTS: {
						from_pretrained(
							id: string,
							opts: object,
						): Promise<{ generate(text: string, o: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }> }>;
					};
					env: { wasmPaths: string };
				};
				await new Promise<void>((resolve, reject) => {
					const script = document.createElement("script");
					script.src = `${base}kokoro.js`;
					script.onload = () => resolve();
					script.onerror = () => reject(new Error(`could not load ${base}kokoro.js`));
					document.head.append(script);
				});
				const kokoro = (window as unknown as { __dgKokoro?: Kokoro }).__dgKokoro;
				if (!kokoro) throw new Error("narration assets did not define Kokoro");
				kokoro.env.wasmPaths = `${base}ort/`;
				const tts = await kokoro.KokoroTTS.from_pretrained(model, { dtype: "q8", device: "wasm" });
				const out: ({ rate: number; pcm: string } | null)[] = [];
				for (const text of texts) {
					if (!text.trim()) {
						out.push(null);
						continue;
					}
					const clip = await tts.generate(text, { voice });
					const bytes = new Uint8Array(clip.audio.buffer, clip.audio.byteOffset, clip.audio.byteLength);
					let binary = "";
					for (let at = 0; at < bytes.length; at += 0x8000)
						binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
					out.push({ rate: clip.sampling_rate, pcm: btoa(binary) });
				}
				return out;
			},
			{ base: NARRATION_ASSET_BASE, texts, voice: options.voice ?? DEFAULT_VOICE, model: MODEL },
		);
		return encoded.map((clip) => {
			if (!clip) return null;
			const bytes = Buffer.from(clip.pcm, "base64");
			const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
			return { sampleRate: clip.rate, pcm };
		});
	} finally {
		await page.close();
	}
}
