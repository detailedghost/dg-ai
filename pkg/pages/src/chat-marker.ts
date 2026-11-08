import {
	CHAT_CODE_KEY,
	CHAT_CODE_PATH,
	CHAT_MARKER_KEY,
	type SessionBootstrap,
} from "@dg/common";

export function readChatCode(url: string): string | undefined {
	const hash = url.split("#")[1];
	if (!hash) return undefined;
	for (const part of hash.split("&")) {
		const [k, v] = part.split("=");
		if (k === CHAT_CODE_KEY && v) return v;
	}
	return undefined;
}

/** Trades the session token for a one-time code, so the URL never carries the token. */
export async function codedPageUrl({
	port,
	path,
	bootstrap,
	fetchFn = globalThis.fetch.bind(globalThis),
}: {
	port: number;
	path: "/chat" | "/board";
	bootstrap: SessionBootstrap;
	fetchFn?: typeof fetch;
}): Promise<string> {
	const response = await fetchFn(`http://127.0.0.1:${port}${CHAT_CODE_PATH}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bootstrap.token}` },
	});
	if (!response.ok) {
		throw new Error(`The daemon did not issue a page code (HTTP ${response.status}).`);
	}
	const { code } = (await response.json()) as { code?: unknown };
	if (typeof code !== "string" || code.length === 0) {
		throw new Error("The daemon did not issue a page code.");
	}
	return `http://127.0.0.1:${port}${path}#${CHAT_CODE_KEY}=${code}`;
}

export function stripChatMarker(url: string): string {
	const [base, hash] = url.split("#");
	if (!hash) return url;
	const kept = hash
		.split("&")
		.filter((p) => ![CHAT_MARKER_KEY, CHAT_CODE_KEY].includes(p.split("=")[0] ?? ""));
	return kept.length ? `${base}#${kept.join("&")}` : base;
}
