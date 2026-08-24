import {
	CHAT_MARKER_KEY,
	type SessionBootstrap,
	validateSessionBootstrap,
} from "@dg/common";

export { CHAT_MARKER_KEY };

export function readChatBootstrap(url: string): SessionBootstrap | undefined {
	const hash = url.split("#")[1];
	if (!hash) return undefined;
	for (const part of hash.split("&")) {
		const [k, v] = part.split("=");
		if (k === CHAT_MARKER_KEY && v) return decodeBootstrap(v);
	}
	return undefined;
}

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

function decodePayload(payload: string): unknown {
	const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64);
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes));
}

export function stripChatMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const kept = hash
		.split("&")
		.filter((p) => p.split("=")[0] !== CHAT_MARKER_KEY);
	return kept.length ? `${base}#${kept.join("&")}` : base;
}
