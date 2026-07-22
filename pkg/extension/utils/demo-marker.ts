/**
 * The `_demo` URL marker. The CLI appends `#…_demo=<base64url(json)>` to the tour's
 * entry URL; this reads the tour script back and strips the marker. Living in the
 * fragment means the server never sees it and removing it is a same-document change.
 * Mirrors skills/browser-batch/bin/demo-marker.ts (separate build roots can't share).
 */

import type { TourScript } from "@dg/common";

export const DEMO_MARKER_KEY = "_demo";

/** Tour script from a URL's fragment marker, or undefined if absent/undecodable. */
export function readDemoScript(url: string): TourScript | undefined {
	const hash = url.split("#")[1];
	if (!hash) return undefined;
	for (const part of hash.split("&")) {
		const [k, v] = part.split("=");
		if (k === DEMO_MARKER_KEY && v) return decodeScript(v);
	}
	return undefined;
}

/** URL with the marker removed from its fragment (any other fragment preserved). */
export function stripDemoMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const kept = hash
		.split("&")
		.filter((p) => p.split("=")[0] !== DEMO_MARKER_KEY);
	return kept.length ? `${base}#${kept.join("&")}` : base;
}

/** Decode base64url(JSON) → TourScript, UTF-8 safe. Returns undefined on any error. */
function decodeScript(payload: string): TourScript | undefined {
	try {
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const bin = atob(b64);
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes)) as TourScript;
	} catch {
		return undefined;
	}
}
