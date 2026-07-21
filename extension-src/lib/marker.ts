/**
 * The `_tab_group` URL marker. The CLI appends `#…_tab_group=<name>` to each URL
 * it opens; the extension groups those tabs into <name> and then strips the marker.
 * Living in the fragment means the server never sees it and removing it is a
 * same-document change (no reload).
 */

export const MARKER_KEY = "_tab_group";

/** Group name from a URL's fragment marker, or undefined if absent. */
export function readGroupMarker(url: string): string | undefined {
	const hash = url.split("#")[1];
	if (!hash) return undefined;
	for (const part of hash.split("&")) {
		const [k, v] = part.split("=");
		if (k === MARKER_KEY && v) return decodeURIComponent(v);
	}
	return undefined;
}

/** URL with the marker removed from its fragment (any other fragment preserved). */
export function stripGroupMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const kept = hash.split("&").filter((p) => p.split("=")[0] !== MARKER_KEY);
	return kept.length ? `${base}#${kept.join("&")}` : base;
}
