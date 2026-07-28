import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Manifest name is prefixed dg-ai- so the loaded extension is identifiable as ours.
export default defineConfig({
	// Pin the zip base name; package name (@dg/extension) sanitizes unpredictably,
	// and ext-release.yml expects dg-ai-extension-<version>-<browser>.zip.
	zip: { name: "dg-ai-extension" },
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
				"Groups marked tabs, plays guided browser tours, and runs local live-page prototype comparisons.",
			// Prototype artifacts use downloads everywhere; video capture's
			// tabCapture + offscreen permissions remain Chrome/Edge-only.
			permissions: [
				"tabs",
				"tabGroups",
				"storage",
				"downloads",
				"alarms",
				// activeTab is what getMediaStreamId means by "invoked for the current page";
				// <all_urls> does not satisfy it, so without this every record gesture throws.
				...(firefox ? [] : ["activeTab", "tabCapture", "offscreen"]),
			],
			// Kokoro fetches its model from Hugging Face; ONNX wasm ships locally.
			// Keep jsDelivr fallback access and permit local wasm compilation.
			...(firefox
				? {
						host_permissions: ["http://127.0.0.1/*"],
					}
				: {
						host_permissions: [
							"<all_urls>",
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
