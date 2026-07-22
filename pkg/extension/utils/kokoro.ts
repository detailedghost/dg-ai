/**
 * Shared Kokoro TTS loader — runs the Kokoro-82M ONNX model locally via
 * transformers.js / ONNX Runtime Web. Used by the settings "test narration"
 * button and the offscreen recorder that mixes narration into demo videos.
 * The model is loaded once and cached for the life of the page.
 */

type KokoroAudio = {
	audio: Float32Array;
	sampling_rate: number;
	toBlob(): Blob;
};
export type KokoroInstance = {
	generate(text: string, opts: { voice: string }): Promise<KokoroAudio>;
};

let ttsPromise: Promise<KokoroInstance> | null = null;

/** Load (and cache) the Kokoro model, pointing ORT at the extension's local wasm. */
export function loadKokoro(): Promise<KokoroInstance> {
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
			{ dtype: "q8", device: "wasm" },
		)) as unknown as KokoroInstance;
	})();
	return ttsPromise;
}
