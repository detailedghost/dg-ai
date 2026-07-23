/**
 * Append the `_demo` marker the dg-ai-extension consumes to play a guided tour.
 * The full tour script rides in the URL fragment as base64url(JSON) so the server
 * never sees it, it's parser-safe (no `=`/`&`), and the extension strips it after
 * loading. Mirrors pkg/extension/utils/demo-marker.ts (separate build roots).
 */

export const DEMO_MARKER_KEY = "_demo";
export const EDIT_MARKER_KEY = "_edit";

/** Append the tour marker; `edit` adds `_edit=1` so the extension opens the review panel. */
export function addDemoMarker(
	url: string,
	script: unknown,
	edit = false,
): string {
	const payload = Buffer.from(JSON.stringify(script), "utf8").toString(
		"base64url",
	);
	const entries = [`${DEMO_MARKER_KEY}=${payload}`];
	if (edit) entries.push(`${EDIT_MARKER_KEY}=1`);
	const [base, hash] = url.split("#");
	const frag = [hash, ...entries].filter(Boolean).join("&");
	return `${base}#${frag}`;
}
