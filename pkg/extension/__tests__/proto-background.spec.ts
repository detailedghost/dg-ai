import { describe, expect, it, mock } from "bun:test";
import type { ProtoNotReadyError, StyleGuide, Verdict } from "@dg/common";
import {
	createProtoHandler,
	registerProto,
	type ProtoBrowserApi,
	type ProtoBrowserRequest,
	type ProtoResultFrame,
} from "@/lib/background/proto";
import { PROTO_PREVIEW_MAX_CHARS } from "@dg/common";
import {
	PROTO_CAPTURE_PREVIEW,
	PROTO_HAS_PENDING,
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
	onRemoved?: (callback: (tabId: number) => void) => void;
};

function unstubbed(method: string): never {
	throw new Error(`${method} was not stubbed for this test`);
}

function buildApi(overrides: ApiOverrides = {}): {
	api: ProtoBrowserApi;
	listener: ProtoListener;
	removeTab: (tabId: number) => void;
} {
	let listener: ProtoListener | undefined;
	let onRemoved: (tabId: number) => void = () => {};
	const api = {
		tabs: {
			create: overrides.create ?? mock(async () => unstubbed("tabs.create")),
			captureVisibleTab:
				overrides.captureVisibleTab ??
				mock(async () => unstubbed("tabs.captureVisibleTab")),
			query: overrides.query ?? mock(async () => []),
			onRemoved: {
				addListener(callback: (tabId: number) => void) {
					onRemoved = callback;
					overrides.onRemoved?.(callback);
				},
			},
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
	return { api, listener, removeTab: (tabId) => onRemoved(tabId) };
}

function restoreGlobal(name: string): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
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
		expect(query).toHaveBeenCalledTimes(4);
		expect(captureVisibleTab).toHaveBeenCalledTimes(2);
	});

	it("drops the preview when the tab changes during capture", async () => {
		let queries = 0;
		const query = mock(async () => {
			queries += 1;
			return queries === 1 ? [{ id: 9 }] : [{ id: 99 }];
		});
		const captureVisibleTab = mock(
			async () => "data:image/jpeg;base64,cHJldmlldw==",
		);
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
		expect(captureVisibleTab).toHaveBeenCalledTimes(1);
		listener({ type: PROTO_SAVE_VERDICT, verdict }, { tab: { id: 9 } }, () => {});
		expect(await resultPromise).toEqual({
			ok: true,
			data: { kind: "verdict", verdict },
		});
	});

	it("omits an oversized preview and still resolves the verdict", async () => {
		const oversized = `data:image/jpeg;base64,${"A".repeat(PROTO_PREVIEW_MAX_CHARS)}`;
		const captureVisibleTab = mock(
			async (
				_windowId: number,
				_options: { format?: string; quality?: number },
			) => oversized,
		);
		const { api, listener } = buildApi({
			create: mock(async () => ({ id: 9 })),
			captureVisibleTab,
			query: mock(async () => [{ id: 9 }]),
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
		listener({ type: PROTO_SAVE_VERDICT, verdict }, { tab: { id: 9 } }, () => {});

		expect(captureResponse).toEqual({
			saved: false,
			reason: "preview exceeded the relay size limit and was omitted",
		});
		expect(captureVisibleTab.mock.calls[0]?.[1]).toEqual({
			format: "jpeg",
			quality: 70,
		});
		expect(await resultPromise).toEqual({
			ok: true,
			data: { kind: "verdict", verdict },
		});
	});

	it("keeps a downscaled preview when OffscreenCanvas can shrink it under the budget", async () => {
		const oversized = `data:image/jpeg;base64,${"A".repeat(PROTO_PREVIEW_MAX_CHARS)}`;
		const widths: number[] = [];
		const restoreCanvas = restoreGlobal("OffscreenCanvas");
		const restoreBitmap = restoreGlobal("createImageBitmap");
		class FakeCanvas {
			width: number;
			height: number;
			constructor(width: number, height: number) {
				this.width = width;
				this.height = height;
				widths.push(width);
			}
			getContext() {
				return { drawImage() {} };
			}
			async convertToBlob() {
				return new Blob([Uint8Array.from([1, 2, 3])], { type: "image/jpeg" });
			}
		}
		Object.defineProperty(globalThis, "OffscreenCanvas", {
			configurable: true,
			value: FakeCanvas,
		});
		Object.defineProperty(globalThis, "createImageBitmap", {
			configurable: true,
			value: async () => ({ width: 2400, height: 1200, close() {} }),
		});
		try {
			const { api, listener } = buildApi({
				create: mock(async () => ({ id: 9 })),
				captureVisibleTab: mock(async () => oversized),
				query: mock(async () => [{ id: 9 }]),
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
			listener(
				{ type: PROTO_SAVE_VERDICT, verdict },
				{ tab: { id: 9 } },
				() => {},
			);
			const result = await resultPromise;
			expect(captureResponse).toEqual({ saved: true });
			expect(widths[0]).toBeLessThanOrEqual(1280);
			expect(result).toMatchObject({
				ok: true,
				data: { kind: "verdict", verdict },
			});
			const preview = (result as { data: { previewDataUrl?: string } }).data
				.previewDataUrl;
			expect(preview?.startsWith("data:image/jpeg;base64,")).toBe(true);
			expect((preview ?? "").length).toBeLessThanOrEqual(PROTO_PREVIEW_MAX_CHARS);
		} finally {
			restoreCanvas();
			restoreBitmap();
		}
	});

	it("finishes with a tab-closed error when the prototype tab is removed", async () => {
		const { api, listener, removeTab } = buildApi({
			create: mock(async () => ({ id: 7 })),
		});
		const handler = createProtoHandler({ browserApi: api });
		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		removeTab(7);
		expect(await resultPromise).toEqual({
			ok: false,
			error: "The prototype tab was closed before a result.",
		});
		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide: buildStyleGuide() },
			{ tab: { id: 7 } },
			() => {},
		);
	});

	it("answers whether the sender tab has a pending relay request", async () => {
		const { api, listener } = buildApi({
			create: mock(async () => ({ id: 7 })),
		});
		const handler = createProtoHandler({ browserApi: api });
		const resultPromise = handler(defaultRequest(), mock(() => {}));
		await flush();
		const pending = await new Promise((resolve) => {
			listener({ type: PROTO_HAS_PENDING }, { tab: { id: 7 } }, resolve);
		});
		const absent = await new Promise((resolve) => {
			listener({ type: PROTO_HAS_PENDING }, { tab: { id: 8 } }, resolve);
		});
		expect(pending).toEqual({ pending: true });
		expect(absent).toEqual({ pending: false });
		listener(
			{ type: PROTO_SAVE_STYLE_GUIDE, styleGuide: buildStyleGuide() },
			{ tab: { id: 7 } },
			() => {},
		);
		await resultPromise;
	});

	it("refuses to open a non-http URL or one past the marker limit", async () => {
		const create = mock(async () => ({ id: 7 }));
		const { api } = buildApi({ create });
		const handler = createProtoHandler({ browserApi: api });
		expect(
			await handler(
				defaultRequest({ markedUrl: "javascript:alert(1)" }),
				mock(() => {}),
			),
		).toEqual({
			ok: false,
			error: "the prototype URL must be an http(s) URL",
		});
		expect(
			await handler(
				defaultRequest({
					markedUrl: `https://example.test/${"a".repeat(40_000)}`,
				}),
				mock(() => {}),
			),
		).toEqual({
			ok: false,
			error: "the prototype URL exceeds the marker URL limit",
		});
		expect(create).not.toHaveBeenCalled();
	});
});
