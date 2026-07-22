import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Manifest name is prefixed dg-ai- so the loaded extension is identifiable as ours.
export default defineConfig({
	/**
	 * onnxruntime-web's default export condition resolves to its "bundle" build,
	 * which statically re-imports the wasm via `new URL(..., import.meta.url)` so
	 * Vite emits a duplicate ~21MB copy into assets/. We ship the wasm ourselves
	 * via public/ort/ (see scripts/copy-ort.ts), so opt into the "extern-wasm"
	 * build variant instead — it resolves wasm paths at runtime, nothing for Vite
	 * to bundle.
	 */
	vite: () => ({
		plugins: [tailwindcss()],
		resolve: {
			conditions: ["onnxruntime-web-use-extern-wasm"],
			alias: {
				"@dg/common": resolve(__dirname, "../common/src/index.ts"),
			},
		},
	}),
	manifest: ({ browser }) => {
		const firefox = browser === "firefox";
		return {
			name: "dg-ai-extension",
			description:
				"Auto-groups PR/URL tabs into named tab groups, and plays guided in-browser demo tours.",
			// Video recording (tabCapture + offscreen + downloads) is Chrome/Edge only.
			permissions: [
				"tabs",
				"tabGroups",
				"storage",
				...(firefox ? [] : ["tabCapture", "offscreen", "downloads"]),
			],
			// Kokoro TTS (transformers.js) downloads the model from Hugging Face and its
			// ONNX-runtime wasm from jsDelivr; allow those and permit wasm compilation.
			...(firefox
				? {}
				: {
						host_permissions: [
							"https://huggingface.co/*",
							"https://*.huggingface.co/*",
							"https://cdn.jsdelivr.net/*",
						],
						content_security_policy: {
							extension_pages:
								"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
						},
					}),
			// Toolbar icon + keyboard shortcut: the user gesture that starts video recording.
			action: {
				default_title: "DeeGee settings",
			},
			commands: {
				"start-demo-recording": {
					suggested_key: { default: "Alt+Shift+D" },
					description: "Start recording the DeeGee demo tour",
				},
			},
			// Firefox-only: ID is required for MV3; declare no-data-collection (Nov 2025 rule).
			...(firefox
				? {
						browser_specific_settings: {
							gecko: {
								id: "dg-ai-extension@detailedghost",
								data_collection_permissions: { required: ["none"] },
							},
						},
					}
				: {}),
		};
	},
});
