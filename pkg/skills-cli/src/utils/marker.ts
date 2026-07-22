/**
 * Append the `_tab_group` marker the dg-ai-extension consumes. Kept in the URL
 * fragment so the server never sees it and the extension can strip it cleanly.
 * An optional position rides along as `_tab_group_pos=<n>` so a batch lands in a
 * chosen order. Mirrors extension-src/lib/marker.ts (separate build roots).
 */

export const MARKER_KEY = "_tab_group";
export const MARKER_POS_KEY = "_tab_group_pos";

export function addGroupMarker(
	url: string,
	name: string,
	pos?: number,
): string {
	let entry = `${MARKER_KEY}=${encodeURIComponent(name)}`;
	if (pos !== undefined) entry += `&${MARKER_POS_KEY}=${pos}`;
	const [base, hash] = url.split("#");
	const frag = hash ? `${hash}&${entry}` : entry;
	return `${base}#${frag}`;
}
