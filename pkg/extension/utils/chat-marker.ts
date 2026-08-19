/**
 * The `_chat` URL marker. Own module per the one-module-per-marker-key convention —
 * mirrors utils/demo-marker.ts's read/strip shape, but decodes a SessionBootstrap
 * via @dg/common's shared validator rather than a hand-rolled schema.
 */

import { type SessionBootstrap, validateSessionBootstrap } from "@dg/common";

export const CHAT_MARKER_KEY = "_chat";

/** Valid SessionBootstrap from a URL marker, or undefined when absent/untrusted. */
export function readChatBootstrap(url: string): SessionBootstrap | undefined {
	const hash = url.split("#")[1];
	if (!hash) return undefined;
	for (const part of hash.split("&")) {
		const [k, v] = part.split("=");
		if (k === CHAT_MARKER_KEY && v) return decodeBootstrap(v);
	}
	return undefined;
}

/** A marker is always a SessionBootstrap, never a lockfile — validate as such directly. */
function decodeBootstrap(payload: string): SessionBootstrap | undefined {
	try {
		return validateSessionBootstrap(decodePayload(payload));
	} catch (err) {
		console.warn(
			"[dg-ai-extension] ignoring an invalid _chat marker:",
			err instanceof Error ? err.message : err,
		);
		return undefined;
	}
}

/** Decode UTF-8 base64url JSON without assigning trust or a schema. */
function decodePayload(payload: string): unknown {
	const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64);
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes));
}

/** URL with the `_chat` entry removed (any other fragment content preserved). */
export function stripChatMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const kept = hash
		.split("&")
		.filter((p) => p.split("=")[0] !== CHAT_MARKER_KEY);
	return kept.length ? `${base}#${kept.join("&")}` : base;
}
