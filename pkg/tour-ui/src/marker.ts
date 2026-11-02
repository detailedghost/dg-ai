import { DEMO_MARKER_KEY, EDIT_MARKER_KEY } from "@dg/common";

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

/** URL with our markers removed from its fragment (any other fragment preserved). */
export function stripDemoMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const ours = new Set([DEMO_MARKER_KEY, EDIT_MARKER_KEY]);
	const kept = hash.split("&").filter((p) => !ours.has(p.split("=")[0]));
	return kept.length ? `${base}#${kept.join("&")}` : base;
}
