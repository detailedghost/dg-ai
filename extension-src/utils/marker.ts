/**
 * The `_tab_group` URL marker. The CLI appends `#…_tab_group=<name>` to each URL
 * it opens; the extension groups those tabs into <name> and then strips the marker.
 * An optional `_tab_group_pos=<n>` carries the tab's position so a batch lands in a
 * chosen order. Living in the fragment means the server never sees it and removing
 * it is a same-document change (no reload).
 */

export const MARKER_KEY = "_tab_group";
export const MARKER_POS_KEY = "_tab_group_pos";

function fragParts(url: string): string[] {
	const hash = url.split("#")[1];
	return hash ? hash.split("&") : [];
}

/** Group name from a URL's fragment marker, or undefined if absent. */
export function readGroupMarker(url: string): string | undefined {
	for (const part of fragParts(url)) {
		const [k, v] = part.split("=");
		if (k === MARKER_KEY && v) return decodeURIComponent(v);
	}
	return undefined;
}

/** Desired position of this tab within its group, or undefined if unspecified. */
export function readGroupPos(url: string): number | undefined {
	for (const part of fragParts(url)) {
		const [k, v] = part.split("=");
		if (k === MARKER_POS_KEY && v !== undefined) {
			const n = Number.parseInt(v, 10);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

/** URL with both group markers removed (any other fragment preserved). */
export function stripGroupMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const kept = hash.split("&").filter((p) => {
		const k = p.split("=")[0];
		return k !== MARKER_KEY && k !== MARKER_POS_KEY;
	});
	return kept.length ? `${base}#${kept.join("&")}` : base;
}
