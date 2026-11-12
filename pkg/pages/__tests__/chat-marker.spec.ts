import { expect, test } from "bun:test";
import type { SessionBootstrap } from "@dg/common";
import {
	codedPageUrl,
	readChatCode,
	stripChatMarker,
} from "../src/chat-marker";

function makeBootstrap(
	overrides: Partial<SessionBootstrap> = {},
): SessionBootstrap {
	return {
		port: 4317,
		sessionId: "sess-abc123",
		token: "tok-xyz789",
		agentIdentity: "claude-orchestrator",
		...overrides,
	};
}

function encodeMarkerPayload(payload: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function urlWithChatMarker(payload: unknown, tail = ""): string {
	return `http://127.0.0.1:4317/bootstrap#_chat=${encodeMarkerPayload(payload)}${tail}`;
}

test("strips only the _chat entry, preserving other fragment entries byte-for-byte", () => {
	const bootstrap = makeBootstrap();
	const url = urlWithChatMarker(bootstrap, "&kept=1");
	const stripped = stripChatMarker(url);
	expect(stripped).toBe("http://127.0.0.1:4317/bootstrap#kept=1");
	expect(stripped).not.toContain("_chat=");
});

test("strips to a bare URL with no # when nothing else remains in the fragment", () => {
	const bootstrap = makeBootstrap();
	const stripped = stripChatMarker(urlWithChatMarker(bootstrap));
	expect(stripped).toBe("http://127.0.0.1:4317/bootstrap");
});

test("leaves a URL with no _chat marker unchanged", () => {
	const url = "http://127.0.0.1:4317/bootstrap#kept=1";
	expect(stripChatMarker(url)).toBe(url);
});

test("leaves a URL with no fragment at all unchanged", () => {
	const url = "http://127.0.0.1:4317/bootstrap";
	expect(stripChatMarker(url)).toBe(url);
});

test("codedPageUrl posts the session token as a bearer and puts only the returned code in the fragment", async () => {
	const bootstrap = makeBootstrap({ port: 4321 });
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Response.json({ code: "one-time-code" });
	}) as unknown as typeof fetch;

	const url = await codedPageUrl({
		port: 4321,
		path: "/board",
		bootstrap,
		fetchFn,
	});

	expect(calls[0]?.url).toBe("http://127.0.0.1:4321/chat/code");
	expect(calls[0]?.init.method).toBe("POST");
	expect(calls[0]?.init.headers).toEqual({
		Authorization: `Bearer ${bootstrap.token}`,
	});
	expect(url).toBe("http://127.0.0.1:4321/board#_chatcode=one-time-code");
	expect(url).not.toContain(bootstrap.token);
});

test("codedPageUrl throws when the daemon refuses to mint a code", async () => {
	const fetchFn = (async () =>
		new Response("refused", { status: 403 })) as unknown as typeof fetch;

	await expect(
		codedPageUrl({ port: 4321, path: "/chat", bootstrap: makeBootstrap(), fetchFn }),
	).rejects.toThrow(/403/);
});

test("readChatCode reads the code from the fragment and ignores other keys", () => {
	expect(readChatCode("http://127.0.0.1:4321/chat#_chatcode=abc-123_x")).toBe(
		"abc-123_x",
	);
	expect(readChatCode("http://127.0.0.1:4321/chat#other=1")).toBeUndefined();
	expect(readChatCode("http://127.0.0.1:4321/chat")).toBeUndefined();
});

test("stripChatMarker also removes the chat code and keeps unrelated keys", () => {
	expect(
		stripChatMarker("http://127.0.0.1:4321/chat#_chatcode=abc&keep=1"),
	).toBe("http://127.0.0.1:4321/chat#keep=1");
	expect(stripChatMarker("http://127.0.0.1:4321/chat#_chatcode=abc")).toBe(
		"http://127.0.0.1:4321/chat",
	);
});
