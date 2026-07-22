#!/usr/bin/env bun
/**
 * Stage kokoro-js's ONNX-runtime .mjs/.wasm into public/ort/ so ORT loads them
 * locally at runtime — MV3's CSP forbids ORT's default CDN fallback. Runs on
 * postinstall (and before build) so a fresh checkout / CI has the files.
 *
 * Under Bun workspaces, kokoro-js (and its nested @huggingface/transformers) may
 * be hoisted to the root node_modules rather than sitting inside pkg/extension/.
 * We use createRequire to resolve the real on-disk location instead of hardcoding
 * a relative path.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "ort");

const require = createRequire(import.meta.url);

function findTransformersDist(): string {
	// 1. Prefer kokoro-js's own pinned copy of transformers (most correct version).
	try {
		const kokoroPkg = require.resolve("kokoro-js/package.json");
		const nested = join(
			dirname(kokoroPkg),
			"node_modules",
			"@huggingface",
			"transformers",
			"dist",
		);
		if (existsSync(nested)) return nested;
	} catch { /* not installed here */ }

	// 2. Fall back to root-hoisted @huggingface/transformers.
	try {
		const tfPkg = require.resolve("@huggingface/transformers/package.json");
		const d = join(dirname(tfPkg), "dist");
		if (existsSync(d)) return d;
	} catch { /* not installed here */ }

	throw new Error(
		"Cannot find @huggingface/transformers/dist. Run `bun install` from pkg/extension/.",
	);
}

const dist = findTransformersDist();
mkdirSync(out, { recursive: true });
for (const f of [
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
]) {
	copyFileSync(join(dist, f), join(out, f));
	console.log(`copied ${f}`);
}
