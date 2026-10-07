/**
 * Append the `_tab_group` marker the dg-ai-extension consumes. Kept in the URL
 * fragment so the server never sees it and the extension can strip it cleanly.
 * An optional position rides along as `_tab_group_pos=<n>` so a batch lands in a
 * chosen order. Mirrors pkg/extension/utils/marker.ts (separate build roots).
 */

import { MARKER_BATCH_KEY, MARKER_KEY, MARKER_POS_KEY } from "@dg/common";

export { MARKER_BATCH_KEY, MARKER_KEY, MARKER_POS_KEY };

export function addGroupMarker(
	url: string,
	name: string,
	pos?: number,
	batch?: string,
): string {
	let entry = `${MARKER_KEY}=${encodeURIComponent(name)}`;
	if (pos !== undefined) entry += `&${MARKER_POS_KEY}=${pos}`;
	if (batch) entry += `&${MARKER_BATCH_KEY}=${encodeURIComponent(batch)}`;
	const [base, hash] = url.split("#");
	const frag = hash ? `${hash}&${entry}` : entry;
	return `${base}#${frag}`;
}
