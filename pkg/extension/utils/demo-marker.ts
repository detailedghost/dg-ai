/**
 * The `_demo` URL marker. The CLI appends `#…_demo=<base64url(json)>` to the tour's
 * entry URL; this reads the tour script back and strips the marker. Living in the
 * fragment means the server never sees it and removing it is a same-document change.
 * Mirrors skills/browser-batch/bin/demo-marker.ts (separate build roots can't share).
 */

import type { TourScript } from "@dg/common";

export const DEMO_MARKER_KEY = "_demo";
export const EDIT_MARKER_KEY = "_edit";

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

/** Build the fragment (`_demo=…[&_edit=1]`) — inverse of readDemoScript, UTF-8 safe. */
export function demoMarkerFragment(script: unknown, edit: boolean): string {
	const bytes = new TextEncoder().encode(JSON.stringify(script));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	const b64 = btoa(bin)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const parts = [`${DEMO_MARKER_KEY}=${b64}`];
	if (edit) parts.push(`${EDIT_MARKER_KEY}=1`);
	return parts.join("&");
}

/** Whether the marker requests the review/edit panel (`_edit=1`). */
export function readEditFlag(url: string): boolean {
	const hash = url.split("#")[1];
	if (!hash) return false;
	return hash.split("&").some((p) => p.split("=")[0] === EDIT_MARKER_KEY);
}

/** URL with our markers removed from its fragment (any other fragment preserved). */
export function stripDemoMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const ours = new Set([DEMO_MARKER_KEY, EDIT_MARKER_KEY]);
	const kept = hash.split("&").filter((p) => !ours.has(p.split("=")[0]));
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
