import type { SessionBootstrap } from "@dg/common";

/**
 * base64url(JSON) in the URL fragment, no compression, mirroring demo-marker.ts.
 * SessionBootstrap's four short fields don't need proto-marker.ts's gzip.
 */
export const CHAT_MARKER_KEY = "_chat";

export function encodeChatMarker(bootstrap: SessionBootstrap): string {
	return Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64url");
}

export function buildBootstrapUrl(
	port: number,
	bootstrap: SessionBootstrap,
): string {
	return `http://127.0.0.1:${port}/start#${CHAT_MARKER_KEY}=${encodeChatMarker(bootstrap)}`;
}
