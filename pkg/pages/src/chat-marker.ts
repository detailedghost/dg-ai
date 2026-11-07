import {
	CHAT_CODE_KEY,
	CHAT_CODE_PATH,
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
