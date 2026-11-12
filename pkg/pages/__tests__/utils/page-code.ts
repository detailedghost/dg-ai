import { CHAT_CODE_KEY, CHAT_EXCHANGE_PATH } from "@dg/common";

export function pageFragment(value: unknown): string {
	return `${CHAT_CODE_KEY}=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export function exchangeReply(
	url: string,
	init: RequestInit | undefined,
): Response | undefined {
	if (!url.endsWith(CHAT_EXCHANGE_PATH)) return undefined;
	const { code } = JSON.parse(String(init?.body)) as { code: string };
	return Response.json(JSON.parse(Buffer.from(code, "base64url").toString()));
}
