#!/usr/bin/env bun
/**
 * Stage kokoro-js's ONNX-runtime .mjs/.wasm into public/ort/ so ORT loads them
 * locally at runtime — MV3's CSP forbids ORT's default CDN fallback. Runs on
 * postinstall (and before build) so a fresh checkout / CI has the files.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(
	here,
	"..",
	"node_modules/kokoro-js/node_modules/@huggingface/transformers/dist",
);
const out = join(here, "..", "public", "ort");
mkdirSync(out, { recursive: true });
for (const f of [
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
]) {
	copyFileSync(join(dist, f), join(out, f));
	console.log(`copied ${f}`);
}
