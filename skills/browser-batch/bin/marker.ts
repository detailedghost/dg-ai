/**
 * Append the `_tab_group` marker the dg-ai-extension consumes. Kept in the URL
 * fragment so the server never sees it and the extension can strip it cleanly.
 * Mirrors extension-src/lib/marker.ts (separate build roots can't share code).
 */

export const MARKER_KEY = "_tab_group";

export function addGroupMarker(url: string, name: string): string {
	const entry = `${MARKER_KEY}=${encodeURIComponent(name)}`;
	const [base, hash] = url.split("#");
	const frag = hash ? `${hash}&${entry}` : entry;
	return `${base}#${frag}`;
}
