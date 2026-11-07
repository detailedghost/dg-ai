import { CHAT_CODE_KEY, CHAT_MARKER_KEY, type SessionBootstrap } from "../index";

function encodeChatMarker(bootstrap: SessionBootstrap): string {
	return Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64url");
}

export function buildBootstrapUrl(
	port: number,
	bootstrap: SessionBootstrap,
	path: "/chat" | "/board" = "/chat",
): string {
	return `http://127.0.0.1:${port}${path}#${CHAT_MARKER_KEY}=${encodeChatMarker(bootstrap)}`;
}

export function buildCodeUrl(
	port: number,
	code: string,
	path: "/chat" | "/board" = "/chat",
): string {
	return `http://127.0.0.1:${port}${path}#${CHAT_CODE_KEY}=${code}`;
}
