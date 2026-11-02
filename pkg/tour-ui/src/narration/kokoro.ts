import type { ModelLoadProgress } from "../narration-progress";

export type KokoroInstance = {
	generate(
		text: string,
		opts: { voice: string },
	): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

type KokoroModule = {
	KokoroTTS: {
		from_pretrained(id: string, opts: object): Promise<KokoroInstance>;
	};
	env: { wasmPaths: string };
};

declare global {
	interface Window {
		__dgKokoro?: KokoroModule;
	}
}

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

let loading: Promise<KokoroInstance> | undefined;
const listeners = new Set<(info: ModelLoadProgress) => void>();

function injectScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = src;
		script.onload = () => {
			script.remove();
			resolve();
		};
		script.onerror = () => reject(new Error(`could not load ${src}`));
		document.head.append(script);
	});
}

/** Loads Kokoro from `assetBase` (kokoro.js and ort/) once per page; the model itself comes from Hugging Face. */
export function loadKokoro(
	assetBase: string,
	onProgress?: (info: ModelLoadProgress) => void,
): Promise<KokoroInstance> {
	if (onProgress) listeners.add(onProgress);
	loading ??= (async () => {
		await injectScript(`${assetBase}kokoro.js`);
		const kokoro = window.__dgKokoro;
		if (!kokoro) throw new Error("narration assets did not define Kokoro");
		kokoro.env.wasmPaths = `${assetBase}ort/`;
		return kokoro.KokoroTTS.from_pretrained(MODEL, {
			dtype: "q8",
			device: "wasm",
			progress_callback: (info: ModelLoadProgress) => {
				for (const listener of listeners) listener(info);
			},
		});
	})();
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}
