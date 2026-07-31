/**
 * Shared Kokoro TTS loader — runs the Kokoro-82M ONNX model locally via
 * transformers.js / ONNX Runtime Web. Used by the settings "test narration"
 * button and the offscreen recorder that mixes narration into demo videos.
 * The model is loaded once and cached for the life of the page.
 */

import type { ModelLoadProgress } from "@/lib/narration-progress";

type KokoroAudio = {
	audio: Float32Array;
	sampling_rate: number;
	toBlob(): Blob;
};
export type KokoroInstance = {
	generate(text: string, opts: { voice: string }): Promise<KokoroAudio>;
};

type ProgressCallback = (progress: ModelLoadProgress) => void;

let ttsPromise: Promise<KokoroInstance> | null = null;
let loaded = false;
const listeners = new Set<ProgressCallback>();

/**
 * Whether the model is already in memory, so a caller can skip its load UI entirely.
 *
 * A load that already finished reports no progress to a caller arriving after it —
 * there is nothing left to report — so a bar keyed only on the callback would sit at
 * 0% describing work that is long done.
 */
export function narrationLoaded(): boolean {
	return loaded;
}

/** Load (and cache) the Kokoro model, pointing ORT at the extension's local wasm. */
export function loadKokoro(
	onProgress?: ProgressCallback,
): Promise<KokoroInstance> {
	// Every caller subscribes, not just the load's starter: otherwise a warm-up already
	// in flight leaves the recorder's preparation bar frozen at 0% for the whole load.
	if (onProgress) listeners.add(onProgress);
	if (ttsPromise) return ttsPromise;
	ttsPromise = (async () => {
		/**
		 * kokoro-js re-exports `env` as a thin proxy whose only writable accessor is
		 * wasmPaths. Point ORT at the extension's bundled ort/ dir (same-origin) so it
		 * doesn't fetch wasm from the jsDelivr CDN, which MV3 CSP blocks. The old
		 * env.backends.onnx.wasm path was undefined on this proxy, so it silently
		 * no-op'd and ORT kept its CDN default.
		 */
		const { KokoroTTS, env } = await import("kokoro-js");
		env.wasmPaths = chrome.runtime.getURL("ort/");
		return (await KokoroTTS.from_pretrained(
			"onnx-community/Kokoro-82M-v1.0-ONNX",
			{
				dtype: "q8",
				device: "wasm",
				progress_callback: (info: ModelLoadProgress) => {
					for (const listener of listeners) listener(info);
				},
			},
		)) as unknown as KokoroInstance;
	})();
	/**
	 * Settle bookkeeping on a derived chain, so callers still receive the real result.
	 *
	 * A failure drops the cached promise rather than poisoning it: the offscreen document
	 * now outlives a single recording, so caching a rejection would disable narration for
	 * the rest of the browser session over one transient fetch.
	 */
	void ttsPromise
		.then(() => {
			loaded = true;
		})
		.catch(() => {
			ttsPromise = null;
		})
		.finally(() => {
			listeners.clear();
		});
	return ttsPromise;
}
