/**
 * Append the `_demo` marker the dg-ai-extension consumes to play a guided tour.
 * The full tour script rides in the URL fragment as base64url(JSON) so the server
 * never sees it, it's parser-safe (no `=`/`&`), and the extension strips it after
 * loading. Mirrors extension-src/lib/demo-marker.ts (separate build roots).
 */

export const DEMO_MARKER_KEY = "_demo";

export function addDemoMarker(url: string, script: unknown): string {
	const payload = Buffer.from(JSON.stringify(script), "utf8").toString(
		"base64url",
	);
	const entry = `${DEMO_MARKER_KEY}=${payload}`;
	const [base, hash] = url.split("#");
	const frag = hash ? `${hash}&${entry}` : entry;
	return `${base}#${frag}`;
}
