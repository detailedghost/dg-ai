/**
 * The `_demo` URL marker. The CLI appends `#…_demo=<base64url(json)>` to the tour's
 * entry URL; this reads the tour script back and strips the marker. Living in the
 * fragment means the server never sees it and removing it is a same-document change.
 * Mirrors pkg/skills-cli/src/utils/demo-marker.ts (separate build roots can't share).
 */

import {
	DEMO_MARKER_KEY,
	EDIT_MARKER_KEY,
	type TourScript,
	validate,
} from "@dg/common";

export { DEMO_MARKER_KEY, EDIT_MARKER_KEY };
export { demoMarkerFragment, stripDemoMarker } from "@dg/tour-ui";

/** Valid same-origin TourScript from a URL marker, or undefined when untrusted. */
export function readDemoScript(url: string): TourScript | undefined {
	const hash = url.split("#")[1];
	if (!hash) return undefined;
	for (const part of hash.split("&")) {
		const [k, v] = part.split("=");
		if (k === DEMO_MARKER_KEY && v)
			return validateDemoMarkerScript(url, decodeScript(v));
	}
	return undefined;
}

/**
 * Accept a decoded marker only when it is a valid TourScript bound to the page
 * that carries it. This is deliberately pure so marker trust can be tested
 * without extension storage or DOM setup.
 */
export function validateDemoMarkerScript(
	markerUrl: string,
	candidate: unknown,
): TourScript | undefined {
	try {
		const script = validate(candidate);
		if (new URL(markerUrl).origin !== new URL(script.startUrl).origin) {
			console.warn(
				"[dg-ai-extension] ignoring a _demo marker whose startUrl is a different origin than the page carrying it",
			);
			return undefined;
		}
		return script;
	} catch (err) {
		// Say why. A rejected plan used to vanish with no trace at all, which reads as
		// the extension being broken rather than the plan being malformed.
		console.warn(
			"[dg-ai-extension] ignoring an invalid _demo marker:",
			err instanceof Error ? err.message : err,
		);
		return undefined;
	}
}

/** Whether the marker requests the review/edit panel (`_edit=1`). */
export function readEditFlag(url: string): boolean {
	const hash = url.split("#")[1];
	if (!hash) return false;
	return hash.split("&").some((p) => p.split("=")[0] === EDIT_MARKER_KEY);
}

/** Decode UTF-8 base64url JSON without assigning trust or a schema. */
function decodeScript(payload: string): unknown {
	try {
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const bin = atob(b64);
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}
