import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { Window } from "happy-dom";
import { buildPages } from "../build";
import { createTranscriptView } from "../src/chat/chat-transcript";

const PORT = 47823;
const PAGE_ORIGIN = `http://127.0.0.1:${PORT}`;
const BUILT = ["chat.html", "chat.js", "board.html", "board.js"].map((name) =>
	join(import.meta.dir, "../dist", name),
);

let servedCsp = "";
const windows: Window[] = [];

beforeAll(async () => {
	if (!BUILT.every((path) => existsSync(path))) await buildPages();
	const { localPageResponse } = await import(
		"../../dg-daemon/src/server/pages"
	);
	servedCsp =
		localPageResponse("/chat", PORT)?.headers.get("Content-Security-Policy") ??
		"";
});

afterEach(async () => {
	await Promise.all(windows.splice(0).map((win) => win.happyDOM.close()));
});

function directiveSources(csp: string, name: string): string[] {
	const directive = csp
		.split(";")
		.map((part) => part.trim().split(/\s+/))
		.find(([directiveName]) => directiveName === name);
	return directive?.slice(1) ?? [];
}

function imgSrcAllows(csp: string, src: string): boolean {
	const sources = directiveSources(csp, "img-src");
	const url = new URL(src);
	if (sources.includes(url.protocol)) return true;
	const fetchable = url.protocol === "http:" || url.protocol === "https:";
	return fetchable && sources.includes("'self'") && url.origin === PAGE_ORIGIN;
}

test("an image attachment renders with a URL the served chat CSP allows", async () => {
	const win = new Window({ url: `${PAGE_ORIGIN}/chat` });
	windows.push(win);
	const container = win.document.createElement("div");
	win.document.body.append(container);
	const view = createTranscriptView(container as unknown as HTMLElement, {
		assetOrigin: PAGE_ORIGIN,
	});
	const blob = new Blob(["fake-image-bytes"], { type: "image/png" });
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			new Response(blob, { status: 200 })) as unknown as typeof fetch,
	);

	try {
		await view.appendAgentMessage(
			{
				type: "agent-message",
				sessionId: "session-a",
				protocolVersion: CHAT_PROTOCOL_VERSION,
				body: "see attached",
				attachmentId: "asset-1",
			},
			"tok-a",
		);
	} finally {
		fetchSpy.mockRestore();
	}

	const src = container
		.querySelector(".chat-transcript__attachment-image")
		?.getAttribute("src");
	expect(src).toBeString();
	expect({ src, allowed: imgSrcAllows(servedCsp, src ?? "") }).toEqual({
		src,
		allowed: true,
	});
});

test("the served chat CSP does not allow images from a foreign origin", () => {
	expect(imgSrcAllows(servedCsp, "https://evil.example/pixel.png")).toBe(false);
});
