import { describe, expect, it, mock } from "bun:test";
import type { ProtoNotReadyError, StyleGuide, Verdict } from "@dg/common";
import {
	createProtoHandler,
	registerProto,
	type ProtoBrowserApi,
	type ProtoBrowserRequest,
	type ProtoResultFrame,
} from "@/lib/background/proto";
import {
	PROTO_CAPTURE_PREVIEW,
	PROTO_NOT_READY,
	PROTO_PROGRESS,
	PROTO_SAVE_STYLE_GUIDE,
	PROTO_SAVE_VERDICT,
} from "@/lib/features/prototype";

type ProtoListener = (
	message: unknown,
	sender: { tab?: { id?: number; windowId?: number } },
	sendResponse: (response: unknown) => void,
) => boolean | undefined;

type FakeMethod = (...args: any[]) => any;

type ApiOverrides = {
	create?: FakeMethod;
	captureVisibleTab?: FakeMethod;
	query?: FakeMethod;
};

function unstubbed(method: string): never {
	throw new Error(`${method} was not stubbed for this test`);
}

function buildApi(overrides: ApiOverrides = {}): {
	api: ProtoBrowserApi;
	listener: ProtoListener;
} {
	let listener: ProtoListener | undefined;
	const api = {
		tabs: {
			create: overrides.create ?? mock(async () => unstubbed("tabs.create")),
			captureVisibleTab:
				overrides.captureVisibleTab ??
				mock(async () => unstubbed("tabs.captureVisibleTab")),
			query: overrides.query ?? mock(async () => []),
		},
		runtime: {
			onMessage: {
				addListener(callback: ProtoListener) {
					listener = callback;
				},
			},
		},
	} as unknown as ProtoBrowserApi;
	registerProto({ browserApi: api });
	if (!listener) throw new Error("prototype listener was not registered");
	return { api, listener };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultRequest(
	overrides: Partial<ProtoBrowserRequest> = {},
): ProtoBrowserRequest {
	return {
		phase: "scrape",
		slug: "account-summary",
		markedUrl: "https://example.test/account",
		...overrides,
	};
}

function buildStyleGuide(): StyleGuide {
	return {
		meta: { url: "https://example.test/account", scrapedAt: 1, sameOrigin: true },
		tokens: {
			customProps: {},
			colors: ["rgb(0, 0, 0)"],
			fontStack: "sans-serif",
			typeScale: [],
			spacing: [],
			radii: [],
			shadows: [],
		},
		components: { button: {}, input: {}, link: {} },
	};
}

function buildVerdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		slug: "account-summary",
		action: "approve",
		selectedKey: "compact",
		ts: 1,
		...overrides,
	} as Verdict;
}

function buildNotReady(overrides: Partial<ProtoNotReadyError> = {}): ProtoNotReadyError {
	return {
		code: "login-page",
		message: "The page looks like a sign-in page.",
		landedUrl: "https://example.test/login",
		...overrides,
	};
}

describe("requestPrototypeBrowserWork / createProtoHandler", () => {
	it("reports a clear error when opening a tab throws", async () => {
		const { api } = buildApi({
			create: mock(async () => {
				throw new Error("no such window");
			}),
		});
		const handler = createProtoHandler({ browserApi: api });

		const result = await handler(defaultRequest(), mock(() => {}));

		expect(result).toEqual({
			ok: false,
			error: "the extension could not open a tab for this URL: no such window",
		});
	});

	it("reports a clear error when the opened tab has no id", async () => {
		const { api } = buildApi({ create: mock(async () => ({})) });
		const handler = createProtoHandler({ browserApi: api });

		const result = await handler(defaultRequest(), mock(() => {}));

		expect(result).toEqual({
			ok: false,
			error: "the extension could not open a tab for this URL",
		});
	});

	it("resolves a scrape request once the correlated tab reports a style guide", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 7 })) });
		const handler = createProtoHandler({ browserApi: api });
		const styleGuide = buildStyleGuide();

		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide },
			{ tab: { id: 7 } },
			() => {},
		);

		expect(await resultPromise).toEqual({
			ok: true,
			data: { kind: "style-guide", styleGuide },
		});
	});

	it("reports an invalid style guide instead of resolving with it", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 7 })) });
		const handler = createProtoHandler({ browserApi: api });

		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide: { ready: true } },
			{ tab: { id: 7 } },
			() => {},
		);

		const result = (await resultPromise) as { ok: false; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toContain("invalid style guide");
	});

	it("resolves a plant request's verdict with no preview when none was captured", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 9 })) });
		const handler = createProtoHandler({ browserApi: api });
		const verdict = buildVerdict();

		const resultPromise = handler(
			defaultRequest({ phase: "plant" }),
			mock(() => {}),
		);
		await flush();
		listener({ type: PROTO_SAVE_VERDICT, verdict }, { tab: { id: 9 } }, () => {});

		const result = await resultPromise;
		expect(result).toEqual({ ok: true, data: { kind: "verdict", verdict } });
		expect(result).not.toHaveProperty("data.previewDataUrl");
	});

	it("reports an invalid verdict instead of resolving with it", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 9 })) });
		const handler = createProtoHandler({ browserApi: api });

		const resultPromise = handler(
			defaultRequest({ phase: "plant" }),
			mock(() => {}),
		);
		await flush();
		listener(
			{ type: PROTO_SAVE_VERDICT, verdict: { slug: "account-summary" } },
			{ tab: { id: 9 } },
			() => {},
		);

		const result = (await resultPromise) as { ok: false; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toContain("invalid verdict");
	});

	it("attaches a previously captured preview to the eventual verdict", async () => {
		const query = mock(async () => [{ id: 9 }]);
		const captureVisibleTab = mock(async () => "data:image/png;base64,cHJldmlldw==");
		const { api, listener } = buildApi({
			create: mock(async () => ({ id: 9 })),
			captureVisibleTab,
			query,
		});
		const handler = createProtoHandler({ browserApi: api });
		const verdict = buildVerdict();

		const resultPromise = handler(
			defaultRequest({ phase: "plant" }),
			mock(() => {}),
		);
		await flush();
		const captureResponse = await new Promise((resolve) => {
			const keepChannelOpen = listener(
				{ type: PROTO_CAPTURE_PREVIEW },
				{ tab: { id: 9, windowId: 3 } },
				resolve,
			);
			expect(keepChannelOpen).toBe(true);
		});
		expect(captureResponse).toEqual({ saved: true });
		listener({ type: PROTO_SAVE_VERDICT, verdict }, { tab: { id: 9 } }, () => {});

		expect(await resultPromise).toEqual({
			ok: true,
			data: {
				kind: "verdict",
				verdict,
				previewDataUrl: "data:image/png;base64,cHJldmlldw==",
			},
		});
	});

	it("skips the preview and leaves it off the verdict when the tab is no longer active", async () => {
		const query = mock(async () => [{ id: 99 }]);
		const captureVisibleTab = mock(async () => "data:image/png;base64,cHJldmlldw==");
		const { api, listener } = buildApi({
			create: mock(async () => ({ id: 9 })),
			captureVisibleTab,
			query,
		});
		const handler = createProtoHandler({ browserApi: api });
		const verdict = buildVerdict();

		const resultPromise = handler(
			defaultRequest({ phase: "plant" }),
			mock(() => {}),
		);
		await flush();
		const captureResponse = await new Promise((resolve) => {
			listener(
				{ type: PROTO_CAPTURE_PREVIEW },
				{ tab: { id: 9, windowId: 3 } },
				resolve,
			);
		});

		expect(captureResponse).toEqual({
			saved: false,
			reason: "prototype tab is no longer active",
		});
		expect(captureVisibleTab).not.toHaveBeenCalled();
		listener({ type: PROTO_SAVE_VERDICT, verdict }, { tab: { id: 9 } }, () => {});
		expect(await resultPromise).toEqual({ ok: true, data: { kind: "verdict", verdict } });
	});

	it("reports the capture failure reason when capturing the visible tab throws", async () => {
		const query = mock(async () => [{ id: 9 }]);
		const captureVisibleTab = mock(async () => {
			throw new Error("capture failed: permission denied");
		});
		const { api, listener } = buildApi({
			create: mock(async () => ({ id: 9 })),
			captureVisibleTab,
			query,
		});
		const handler = createProtoHandler({ browserApi: api });
		void handler(defaultRequest({ phase: "plant" }), mock(() => {}));
		await flush();

		const captureResponse = await new Promise((resolve) => {
			listener(
				{ type: PROTO_CAPTURE_PREVIEW },
				{ tab: { id: 9, windowId: 3 } },
				resolve,
			);
		});

		expect(captureResponse).toEqual({
			saved: false,
			reason: "capture failed: permission denied",
		});
	});

	it("resolves with a typed not-ready error instead of treating it as a transport failure", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 7 })) });
		const handler = createProtoHandler({ browserApi: api });
		const notReady = buildNotReady();

		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		listener({ type: PROTO_NOT_READY, error: notReady }, { tab: { id: 7 } }, () => {});

		expect(await resultPromise).toEqual({ ok: false, notReady });
	});

	it("reports an invalid not-ready error instead of resolving with it", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 7 })) });
		const handler = createProtoHandler({ browserApi: api });

		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		listener(
			{ type: PROTO_NOT_READY, error: { code: "not-a-real-code" } },
			{ tab: { id: 7 } },
			() => {},
		);

		const result = (await resultPromise) as { ok: false; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toContain("invalid not-ready");
	});

	it("reports progress without settling the pending request", async () => {
		const { api, listener } = buildApi({ create: mock(async () => ({ id: 7 })) });
		const handler = createProtoHandler({ browserApi: api });
		const onProgress = mock((_status: string) => {});

		const resultPromise = handler(defaultRequest(), onProgress);
		await flush();
		listener(
			{ type: PROTO_PROGRESS, status: "ready; scraping the style guide" },
			{ tab: { id: 7 } },
			() => {},
		);
		await flush();

		expect(onProgress).toHaveBeenCalledWith("ready; scraping the style guide");
		const outcome = await Promise.race([
			resultPromise.then(() => "settled"),
			flush().then(() => "still-pending"),
		]);
		expect(outcome).toBe("still-pending");

		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide: buildStyleGuide() },
			{ tab: { id: 7 } },
			() => {},
		);
		await resultPromise;
	});

	it("ignores a message for a tab id with no pending request", () => {
		const { listener } = buildApi();

		expect(() =>
			listener(
				{ type: PROTO_SAVE_VERDICT, verdict: buildVerdict() },
				{ tab: { id: 404 } },
				() => {},
			),
		).not.toThrow();
	});

	it("opens the tab through a Chrome-style callback API", async () => {
		const create = mock(
			(_props: unknown, callback: (tab: { id: number }) => void) => {
				callback({ id: 11 });
			},
		);
		const { api, listener } = buildApi({
			create,
		});
		const handler = createProtoHandler({ browserApi: api });
		const styleGuide = buildStyleGuide();

		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide },
			{ tab: { id: 11 } },
			() => {},
		);

		expect(await resultPromise).toEqual({
			ok: true,
			data: { kind: "style-guide", styleGuide },
		});
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("opens the tab through a Firefox-style Promise-only API", async () => {
		const create = mock((_props: unknown, callback?: unknown) => {
			if (callback !== undefined) throw new TypeError("too many arguments");
			return Promise.resolve({ id: 13 });
		});
		const { api, listener } = buildApi({
			create,
		});
		const handler = createProtoHandler({ browserApi: api });
		const styleGuide = buildStyleGuide();

		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide },
			{ tab: { id: 13 } },
			() => {},
		);

		expect(await resultPromise).toEqual({
			ok: true,
			data: { kind: "style-guide", styleGuide },
		});
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("queries and captures the visible tab through Firefox-style Promise-only APIs", async () => {
		const query = mock((_queryInfo: unknown, callback?: unknown) => {
			if (callback !== undefined) throw new TypeError("too many arguments");
			return Promise.resolve([{ id: 9 }]);
		});
		const captureVisibleTab = mock(
			(_windowId: number, _options: unknown, callback?: unknown) => {
				if (callback !== undefined) throw new TypeError("too many arguments");
				return Promise.resolve("data:image/png;base64,cHJldmlldw==");
			},
		);
		const { api, listener } = buildApi({
			create: mock(async () => ({ id: 9 })),
			captureVisibleTab,
			query,
		});
		void createProtoHandler({ browserApi: api })(
			defaultRequest({ phase: "plant" }),
			mock(() => {}),
		);
		await flush();

		const captureResponse = await new Promise((resolve) => {
			listener(
				{ type: PROTO_CAPTURE_PREVIEW },
				{ tab: { id: 9, windowId: 3 } },
				resolve,
			);
		});

		expect(captureResponse).toEqual({ saved: true });
		expect(query).toHaveBeenCalledTimes(2);
		expect(captureVisibleTab).toHaveBeenCalledTimes(2);
	});
});
