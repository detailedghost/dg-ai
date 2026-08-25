import { CHAT_MARKER_KEY, type SessionBootstrap } from "../index";

function encodeChatMarker(bootstrap: SessionBootstrap): string {
	return Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64url");
}

export function buildBootstrapUrl(
	port: number,
	bootstrap: SessionBootstrap,
): string {
	return `http://127.0.0.1:${port}/start#${CHAT_MARKER_KEY}=${encodeChatMarker(bootstrap)}`;
}
