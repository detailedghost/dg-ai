import { CHAT_CODE_KEY } from "../index";

export function buildCodeUrl(
	port: number,
	code: string,
	path: "/chat" | "/board" = "/chat",
): string {
	return `http://127.0.0.1:${port}${path}#${CHAT_CODE_KEY}=${code}`;
}
