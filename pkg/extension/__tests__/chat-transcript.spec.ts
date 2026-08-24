import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAT_MAX_ASSET_BYTES, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { createTestContainer, fire } from "./utils/dom-events";
import { buildAgentMessageFrame } from "./utils/frame-fixtures";

const { createTranscriptView } = await import("@/lib/features/chat-transcript");

function buildCommandResultFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "command-result" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		ok: true,
		...overrides,
	};
}

test("hostile transcript content renders as visible text and executes nothing", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);
	const hostileBodies = [
		"<script>globalThis.__pwned = true;</script>",
		'<img src=x onerror="globalThis.__pwned = true">',
		'<a href="javascript:globalThis.__pwned = true">click me</a>',
		"```js\nglobalThis.__pwned = true;\n```",
	];

	for (const body of hostileBodies) {
		await view.appendAgentMessage(buildAgentMessageFrame({ body }), "tok");
	}

	expect(container.querySelector("script")).toBeNull();
	expect(container.querySelector("img[onerror]")).toBeNull();
	expect(container.innerHTML).not.toContain("<script>");
	const renderedBodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(renderedBodies).toEqual(hostileBodies);
	expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
});

test("appendUserMessage renders the body as visible text with the user message modifier class", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.appendUserMessage("what should I do next?");

	const message = container.querySelector(".chat-transcript__message--user");
	expect(message).not.toBeNull();
	expect(message?.querySelector(".chat-transcript__body")?.textContent).toBe(
		"what should I do next?",
	);
});

test("hostile content in a user-composed message renders as visible text and executes nothing", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);
	const hostileBody =
		'<a href="javascript:globalThis.__pwned = true">click me</a>';

	view.appendUserMessage(hostileBody);

	expect(container.querySelector("a")).toBeNull();
	expect(
		container.querySelector(
			".chat-transcript__message--user .chat-transcript__body",
		)?.textContent,
	).toBe(hostileBody);
	expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
});

test("appendCommandResult renders a successful result's output text with the ok modifier class", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.appendCommandResult(
		buildCommandResultFrame({ ok: true, output: "command finished cleanly" }),
	);

	const message = container.querySelector(
		".chat-transcript__command-result--ok",
	);
	expect(message).not.toBeNull();
	expect(message?.querySelector(".chat-transcript__body")?.textContent).toBe(
		"command finished cleanly",
	);
	expect(
		container.querySelector(".chat-transcript__command-result--error"),
	).toBeNull();
});

test("appendCommandResult renders a failed result's error text with the error modifier class", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.appendCommandResult(
		buildCommandResultFrame({ ok: false, error: "exit code 1" }),
	);

	const message = container.querySelector(
		".chat-transcript__command-result--error",
	);
	expect(message).not.toBeNull();
	expect(message?.querySelector(".chat-transcript__body")?.textContent).toBe(
		"exit code 1",
	);
	expect(
		container.querySelector(".chat-transcript__command-result--ok"),
	).toBeNull();
});

test("hostile content in a command result's output/error renders as visible text and executes nothing", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);
	const hostileOutput = '<img src=x onerror="globalThis.__pwned = true">';
	const hostileError = "<script>globalThis.__pwned = true;</script>";

	view.appendCommandResult(
		buildCommandResultFrame({ ok: true, output: hostileOutput }),
	);
	view.appendCommandResult(
		buildCommandResultFrame({ ok: false, error: hostileError }),
	);

	expect(container.querySelector("script")).toBeNull();
	expect(container.querySelector("img[onerror]")).toBeNull();
	const bodies = Array.from(
		container.querySelectorAll(
			".chat-transcript__command-result .chat-transcript__body",
		),
	).map((n) => n.textContent);
	expect(bodies).toEqual([hostileOutput, hostileError]);
	expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
});

test("emits class-hooked DOM only — source carries no inline styles and does not import ui-helpers's style-applying createEl", () => {
	const source = readFileSync(
		fileURLToPath(
			new URL("../lib/features/chat-transcript.ts", import.meta.url),
		),
		"utf8",
	);
	expect(source).not.toMatch(/\.style\.[a-zA-Z]/);
	expect(source).not.toMatch(/setAttribute\(\s*["']style["']/);
	expect(source).not.toMatch(/from ["']@\/lib\/ui-helpers["']/);
});

test("progress frames update a single indicator element rather than appending transcript entries", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.updateProgress("running");
	view.updateProgress("awaiting-input");
	view.updateProgress("agent-gone");

	expect(container.querySelectorAll(".chat-transcript__message")).toHaveLength(
		0,
	);
	const indicators = container.querySelectorAll(".chat-transcript__progress");
	expect(indicators).toHaveLength(1);
	expect(indicators[0]?.getAttribute("data-state")).toBe("agent-gone");
});

test("the progress indicator carries real text for sighted users and assistive tech, not an empty div", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.updateProgress("running");
	const indicator = container.querySelector(".chat-transcript__progress");
	expect(indicator?.textContent?.trim().length).toBeGreaterThan(0);
	expect(indicator?.getAttribute("role")).toBe("status");

	view.updateProgress("awaiting-input");
	const textAtAwaitingInput = indicator?.textContent;
	view.updateProgress("agent-gone");
	expect(indicator?.textContent).not.toBe(textAtAwaitingInput);
	expect(indicator?.textContent?.trim().length).toBeGreaterThan(0);
});

test("appending a real agent message does not touch the progress indicator's element count", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);
	view.updateProgress("running");

	await view.appendAgentMessage(
		buildAgentMessageFrame({ body: "final answer" }),
		"tok",
	);

	expect(container.querySelectorAll(".chat-transcript__progress")).toHaveLength(
		1,
	);
	expect(container.querySelectorAll(".chat-transcript__message")).toHaveLength(
		1,
	);
});

test("renders an attachment from a fetched blob URL when the asset is available", async () => {
	const container = createTestContainer();
	let capturedArgs: [string, string, string] | undefined;
	const fetchAsset = async (
		assetId: string,
		sessionId: string,
		token: string,
	) => {
		capturedArgs = [assetId, sessionId, token];
		return { status: "ok" as const, blobUrl: "blob:fake-url-123" };
	};
	const view = createTranscriptView(container, { fetchAsset });

	await view.appendAgentMessage(
		buildAgentMessageFrame({
			body: "see attached",
			attachmentId: "asset-1",
			sessionId: "session-a",
		}),
		"tok-a",
	);

	const image = container.querySelector(
		".chat-transcript__attachment-image",
	) as unknown as HTMLImageElement | null;
	expect(image).not.toBeNull();
	expect(image?.getAttribute("src")).toBe("blob:fake-url-123");
	expect(capturedArgs).toEqual(["asset-1", "session-a", "tok-a"]);
	expect(
		container.querySelector(".chat-transcript__attachment--removed"),
	).toBeNull();
});

test("renders an explicit asset-removed placeholder, distinguishable from a load failure", async () => {
	const container = createTestContainer();
	const fetchAsset = async () => ({ status: "removed" as const });
	const view = createTranscriptView(container, { fetchAsset });

	await view.appendAgentMessage(
		buildAgentMessageFrame({ body: "gone now", attachmentId: "asset-2" }),
		"tok",
	);

	expect(
		container.querySelector(".chat-transcript__attachment--removed"),
	).not.toBeNull();
	expect(
		container.querySelector(".chat-transcript__attachment--error"),
	).toBeNull();
	expect(
		container.querySelector(".chat-transcript__attachment-image"),
	).toBeNull();
});

test("a generic fetch failure renders as a load-error placeholder, distinct from asset-removed", async () => {
	const container = createTestContainer();
	const fetchAsset = async () => ({ status: "error" as const });
	const view = createTranscriptView(container, { fetchAsset });

	await view.appendAgentMessage(
		buildAgentMessageFrame({ body: "oops", attachmentId: "asset-3" }),
		"tok",
	);

	expect(
		container.querySelector(".chat-transcript__attachment--error"),
	).not.toBeNull();
	expect(
		container.querySelector(".chat-transcript__attachment--removed"),
	).toBeNull();
});

test("the default asset fetch authenticates via a request header, never a URL query string, and renders the resulting blob", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container, { port: 47823 });
	const blob = new Blob(["fake-image-bytes"], { type: "image/png" });
	let capturedUrl: string | undefined;
	let capturedInit: RequestInit | undefined;
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		url: string,
		init?: RequestInit,
	) => {
		capturedUrl = url;
		capturedInit = init;
		return {
			status: 200,
			ok: true,
			blob: async () => blob,
		} as unknown as Response;
	}) as typeof fetch);

	try {
		await view.appendAgentMessage(
			buildAgentMessageFrame({
				body: "see attached",
				attachmentId: "asset-real",
				sessionId: "session-a",
			}),
			"secret-token",
		);
	} finally {
		fetchSpy.mockRestore();
	}

	expect(capturedUrl).not.toContain("secret-token");
	const headers = capturedInit?.headers as Record<string, string> | undefined;
	expect(headers?.["X-Dg-Session-Id"]).toBe("session-a");
	expect(headers?.["X-Dg-Session-Token"]).toBe("secret-token");
	const image = container.querySelector(
		".chat-transcript__attachment-image",
	) as unknown as HTMLImageElement | null;
	expect(image?.getAttribute("src")).toMatch(/^blob:/);
});

test("the default asset fetch maps a 404 to the removed placeholder, distinct from any other non-ok status", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container, { port: 47823 });
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			({
				status: 404,
				ok: false,
			}) as unknown as Response) as unknown as typeof fetch,
	);

	try {
		await view.appendAgentMessage(
			buildAgentMessageFrame({ body: "gone", attachmentId: "asset-404" }),
			"tok",
		);
	} finally {
		fetchSpy.mockRestore();
	}

	expect(
		container.querySelector(".chat-transcript__attachment--removed"),
	).not.toBeNull();
	expect(
		container.querySelector(".chat-transcript__attachment--error"),
	).toBeNull();
});

test("the default fetchAsset throws a clear configuration error when port is omitted, rather than silently fetching this page's own origin", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);
	const fetchSpy = spyOn(globalThis, "fetch");

	try {
		await expect(
			view.appendAgentMessage(
				buildAgentMessageFrame({ body: "oops", attachmentId: "asset-x" }),
				"tok",
			),
		).rejects.toThrow(/options\.port is required/);
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
	}
});

test("the default asset fetch refuses an oversized asset on its Content-Length, before the body is ever read", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container, { port: 47823 });
	const blobCalls = mock(() => Promise.resolve(new Blob(["never read"])));
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			({
				status: 200,
				ok: true,
				headers: { get: () => String(CHAT_MAX_ASSET_BYTES + 1) },
				blob: blobCalls,
			}) as unknown as Response) as unknown as typeof fetch,
	);

	try {
		await view.appendAgentMessage(
			buildAgentMessageFrame({ body: "huge", attachmentId: "asset-huge" }),
			"tok",
		);
	} finally {
		fetchSpy.mockRestore();
	}

	expect(blobCalls).not.toHaveBeenCalled();
	expect(
		container.querySelector(".chat-transcript__attachment--error"),
	).not.toBeNull();
	expect(
		container.querySelector(".chat-transcript__attachment-image"),
	).toBeNull();
});

test("the default asset fetch refuses a body that outruns a missing or lying Content-Length", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container, { port: 47823 });
	const oversized = new Blob([new Uint8Array(CHAT_MAX_ASSET_BYTES + 1)]);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			({
				status: 200,
				ok: true,
				headers: { get: () => null },
				blob: async () => oversized,
			}) as unknown as Response) as unknown as typeof fetch,
	);

	try {
		await view.appendAgentMessage(
			buildAgentMessageFrame({ body: "liar", attachmentId: "asset-liar" }),
			"tok",
		);
	} finally {
		fetchSpy.mockRestore();
	}

	expect(
		container.querySelector(".chat-transcript__attachment--error"),
	).not.toBeNull();
});

test("a rendered attachment hands its blob URL back once the image settles, instead of pinning the bytes for the tab's life", async () => {
	const container = createTestContainer();
	const blobUrl = "blob:fake-url-to-revoke";
	const view = createTranscriptView(container, {
		fetchAsset: async () => ({ status: "ok" as const, blobUrl }),
	});
	const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(
		() => undefined,
	);

	try {
		await view.appendAgentMessage(
			buildAgentMessageFrame({ body: "see attached", attachmentId: "asset-1" }),
			"tok",
		);
		const image = container.querySelector(
			".chat-transcript__attachment-image",
		) as unknown as HTMLImageElement;
		expect(image.getAttribute("src")).toBe(blobUrl);
		expect(revokeSpy).not.toHaveBeenCalled();

		fire(image, "load");
		expect(revokeSpy).toHaveBeenCalledWith(blobUrl);
		expect(revokeSpy).toHaveBeenCalledTimes(1);

		fire(image, "load");
		expect(revokeSpy).toHaveBeenCalledTimes(1);
	} finally {
		revokeSpy.mockRestore();
	}
});

test("a failed image load also releases the blob URL, so a broken attachment leaks nothing", async () => {
	const container = createTestContainer();
	const blobUrl = "blob:fake-url-that-fails";
	const view = createTranscriptView(container, {
		fetchAsset: async () => ({ status: "ok" as const, blobUrl }),
	});
	const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(
		() => undefined,
	);

	try {
		await view.appendAgentMessage(
			buildAgentMessageFrame({ body: "broken", attachmentId: "asset-2" }),
			"tok",
		);
		const image = container.querySelector(
			".chat-transcript__attachment-image",
		) as unknown as HTMLImageElement;
		fire(image, "error");
		expect(revokeSpy).toHaveBeenCalledWith(blobUrl);
	} finally {
		revokeSpy.mockRestore();
	}
});

test("regression: two agent messages append in call order even when the first one's attachment fetch resolves after the second call returns", async () => {
	const container = createTestContainer();
	const fetchAsset = async (): Promise<
		Extract<
			import("@/lib/features/chat-transcript").FetchAssetResult,
			{ status: "ok" }
		>
	> => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { status: "ok", blobUrl: "blob:fake" };
	};
	const view = createTranscriptView(container, { fetchAsset });

	const first = view.appendAgentMessage(
		buildAgentMessageFrame({ body: "FIRST", attachmentId: "asset-1" }),
		"tok",
	);
	const second = view.appendAgentMessage(
		buildAgentMessageFrame({ body: "SECOND" }),
		"tok",
	);
	await Promise.all([first, second]);

	const bodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(bodies).toEqual(["FIRST", "SECOND"]);
});

test("applyHistory populates the transcript from the history response's seq-ascending stored-record items, keyed on role", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.applyHistory(
		[
			{
				seq: 1,
				id: "msg-1",
				role: "user",
				body: "first question",
				createdAt: "2026-08-18T00:00:00.000Z",
			},
			{
				seq: 2,
				id: "msg-2",
				role: "agent",
				body: "first answer",
				createdAt: "2026-08-18T00:00:01.000Z",
			},
		],
		"session-a",
		"tok",
	);

	const bodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(bodies).toEqual(["first question", "first answer"]);
});

test("an empty history response (today's daemon behavior) leaves the transcript empty rather than erroring", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	expect(() => view.applyHistory([], "session-a", "tok")).not.toThrow();

	expect(container.querySelectorAll(".chat-transcript__message")).toHaveLength(
		0,
	);
});

test("applyHistory fetches and renders the attachment of an item carrying attachmentId, so a reconnect does not degrade a staged image to bare text", async () => {
	const container = createTestContainer();
	const calls: Array<[string, string, string]> = [];
	const fetchAsset = async (
		assetId: string,
		sessionId: string,
		token: string,
	) => {
		calls.push([assetId, sessionId, token]);
		return { status: "ok" as const, blobUrl: "blob:history-asset" };
	};
	const view = createTranscriptView(container, { fetchAsset });

	await view.applyHistory(
		[
			{
				seq: 1,
				id: "msg-1",
				role: "agent",
				body: "see the older attachment",
				createdAt: "2026-08-18T00:00:00.000Z",
				attachmentId: "asset-old",
			},
		],
		"session-a",
		"tok",
	);

	expect(calls).toEqual([["asset-old", "session-a", "tok"]]);
	expect(container.querySelector(".chat-transcript__body")?.textContent).toBe(
		"see the older attachment",
	);
	expect(
		container
			.querySelector(".chat-transcript__attachment-image")
			?.getAttribute("src"),
	).toBe("blob:history-asset");
});

test("applyHistory renders the text body alone when no token is available, rather than firing an unauthenticated asset fetch", async () => {
	const container = createTestContainer();
	let fetchAssetCalls = 0;
	const fetchAsset = async () => {
		fetchAssetCalls += 1;
		return { status: "ok" as const, blobUrl: "blob:unused" };
	};
	const view = createTranscriptView(container, { fetchAsset });

	await view.applyHistory(
		[
			{
				seq: 1,
				id: "msg-1",
				role: "agent",
				body: "see the older attachment",
				createdAt: "2026-08-18T00:00:00.000Z",
				attachmentId: "asset-old",
			},
		],
		"session-a",
		"",
	);

	expect(fetchAssetCalls).toBe(0);
	expect(container.querySelector(".chat-transcript__attachment")).toBeNull();
	expect(container.querySelector(".chat-transcript__body")?.textContent).toBe(
		"see the older attachment",
	);
});
