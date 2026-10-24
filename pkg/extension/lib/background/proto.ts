import {
	PROTO_DEFAULT_TIMEOUT_MS,
	PROTO_MARKED_URL_MAX_LENGTH,
	PROTO_MAX_TIMEOUT_MS,
	PROTO_PREVIEW_MAX_CHARS,
	validateProtoNotReadyError,
	validateStyleGuide,
	validateVerdict,
	type ProtoBrowserData,
	type ProtoNotReadyError,
} from "@dg/common";
import { type Browser, browser } from "wxt/browser";
import { callBrowserApi } from "@/lib/browser-call";
import {
	PROTO_CAPTURE_PREVIEW,
	PROTO_HAS_PENDING,
	PROTO_NOT_READY,
	PROTO_PROGRESS,
	PROTO_SAVE_STYLE_GUIDE,
	PROTO_SAVE_VERDICT,
} from "@/lib/features/prototype";

/** What the extension opened a tab to do; the marked URL already carries the plan for a plant. */
export type ProtoBrowserRequest = {
	phase: "scrape" | "plant";
	slug: string;
	markedUrl: string;
	/** Daemon relay deadline. The extension finishes slightly after it. */
	timeoutMs?: number;
};

/** Settled outcome of one proto browser request: resolved data, a typed not-ready error, or any other failure. */
export type ProtoResultFrame =
	| { ok: true; data: ProtoBrowserData }
	| { ok: false; notReady: ProtoNotReadyError }
	| { ok: false; error: string };

type MaybeCallbackMethod<TArgs extends unknown[], TResult> = (
	...args: [...TArgs, ((value: TResult) => void)?]
) => PromiseLike<TResult> | void;

/** Browser API surface required to open a tab, track its preview, and read its content-script reports. */
export type ProtoBrowserApi = {
	tabs: {
		create: MaybeCallbackMethod<
			[Browser.tabs.CreateProperties],
			Browser.tabs.Tab
		>;
		captureVisibleTab: MaybeCallbackMethod<
			[number, Browser.extensionTypes.ImageDetails],
			string
		>;
		query: MaybeCallbackMethod<[Browser.tabs.QueryInfo], Browser.tabs.Tab[]>;
		remove: MaybeCallbackMethod<[number | number[]], void>;
		onRemoved: {
			addListener(callback: (tabId: number) => void): void;
		};
	};
	runtime: {
		lastError?: { message?: string };
		onMessage: {
			addListener(
				callback: (
					message: unknown,
					sender: Browser.runtime.MessageSender,
					sendResponse: (response: unknown) => void,
				) => boolean | undefined | void,
			): void;
		};
	};
};

type TabPending = {
	closed?: boolean;
	onProgress: (status: string) => void;
	previewDataUrl?: string;
	resolve: (result: ProtoResultFrame) => void;
};

/**
 * Hold the preview a little past the daemon deadline so a picker the user is
 * still looking at is not cleared first. After this, the entry and its preview
 * are dropped even if the tab stays open.
 */
const PROTO_DEADLINE_MARGIN_MS = 5_000;

export const PROTO_DEADLINE_ERROR =
	"The prototype request reached the extension deadline before a result.";

/** Extension-side deadline for one relay request: the daemon timeout plus a short margin. */
export function protoExtensionDeadlineMs(
	phase: ProtoBrowserRequest["phase"],
	timeoutMs?: number,
): number {
	const base =
		typeof timeoutMs === "number" &&
		Number.isFinite(timeoutMs) &&
		timeoutMs > 0 &&
		timeoutMs <= PROTO_MAX_TIMEOUT_MS
			? timeoutMs
			: PROTO_DEFAULT_TIMEOUT_MS[phase];
	return base + PROTO_DEADLINE_MARGIN_MS;
}

const pendingByTab = new Map<number, TabPending>();

function isMessageOfType(
	message: unknown,
	type: string,
): message is Record<string, unknown> {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as Record<string, unknown>).type === type
	);
}

function browserCall<T>(
	api: ProtoBrowserApi,
	method: MaybeCallbackMethod<unknown[], T>,
	args: unknown[],
): Promise<T> {
	return callBrowserApi(
		(callback) => method(...args, callback),
		() => method(...args) as PromiseLike<T>,
		() => api.runtime.lastError?.message,
	);
}

const PREVIEW_DATA_URL = /^data:image\/(?:png|jpeg);base64,/i;
const PREVIEW_JPEG_QUALITY = 70;

function previewByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function dataUrlToBlob(dataUrl: string): Blob {
	const comma = dataUrl.indexOf(",");
	const meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
	const payload = comma >= 0 ? dataUrl.slice(comma + 1) : "";
	const mime = /^data:([^;,]+)/i.exec(meta)?.[1] ?? "image/jpeg";
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	const mime = blob.type || "image/jpeg";
	return `data:${mime};base64,${btoa(binary)}`;
}

/** Shrink a captured preview with OffscreenCanvas until it fits the relay budget. */
async function downscalePreview(dataUrl: string): Promise<string | undefined> {
	if (
		typeof OffscreenCanvas !== "function" ||
		typeof createImageBitmap !== "function"
	) {
		return undefined;
	}
	const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
	try {
		let quality = PREVIEW_JPEG_QUALITY / 100;
		let width = bitmap.width;
		let height = bitmap.height;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const maxWidth = attempt === 0 ? Math.min(width, 1280) : Math.max(320, Math.round(width * 0.7));
			const scale = width > 0 ? maxWidth / width : 1;
			const canvas = new OffscreenCanvas(
				Math.max(1, Math.round(width * scale)),
				Math.max(1, Math.round(height * scale)),
			);
			const context = canvas.getContext("2d");
			if (!context) return undefined;
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await canvas.convertToBlob({
				type: "image/jpeg",
				quality,
			});
			const next = await blobToDataUrl(blob);
			if (
				PREVIEW_DATA_URL.test(next) &&
				previewByteLength(next) <= PROTO_PREVIEW_MAX_CHARS
			) {
				return next;
			}
			width = canvas.width;
			height = canvas.height;
			quality = Math.max(0.4, quality - 0.1);
		}
		return undefined;
	} finally {
		bitmap.close();
	}
}

async function fitPreviewDataUrl(
	dataUrl: string,
): Promise<{ dataUrl?: string; reason?: string }> {
	if (!PREVIEW_DATA_URL.test(dataUrl)) {
		return { reason: "preview was not a PNG or JPEG data URL" };
	}
	const fitted =
		previewByteLength(dataUrl) <= PROTO_PREVIEW_MAX_CHARS
			? dataUrl
			: await downscalePreview(dataUrl);
	if (
		!fitted ||
		!PREVIEW_DATA_URL.test(fitted) ||
		previewByteLength(fitted) > PROTO_PREVIEW_MAX_CHARS
	) {
		return {
			reason: "preview exceeded the relay size limit and was omitted",
		};
	}
	return { dataUrl: fitted };
}

async function captureVisibleTab(
	api: ProtoBrowserApi,
	windowId: number,
): Promise<string> {
	const dataUrl = await browserCall(
		api,
		api.tabs.captureVisibleTab as MaybeCallbackMethod<unknown[], string>,
		[windowId, { format: "jpeg", quality: PREVIEW_JPEG_QUALITY }],
	);
	if (!dataUrl) throw new Error("capture returned no image");
	return dataUrl;
}

async function activeTabIds(
	api: ProtoBrowserApi,
	windowId: number,
): Promise<number[]> {
	const activeTabs = await browserCall(
		api,
		api.tabs.query as MaybeCallbackMethod<unknown[], Browser.tabs.Tab[]>,
		[{ active: true, windowId }],
	);
	return activeTabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
}

function markedUrlRejection(markedUrl: string): string | undefined {
	if (markedUrl.length > PROTO_MARKED_URL_MAX_LENGTH) {
		return "the prototype URL exceeds the marker URL limit";
	}
	try {
		const url = new URL(markedUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return "the prototype URL must be an http(s) URL";
		}
	} catch {
		return "the prototype URL must be an http(s) URL";
	}
	return undefined;
}

/** Capture the planted tab's visible preview and remember it for the eventual verdict result. */
async function capturePreview(
	api: ProtoBrowserApi,
	pending: TabPending,
	sender: Browser.runtime.MessageSender,
): Promise<{ saved: boolean; reason?: string }> {
	const tabId = sender.tab?.id;
	const windowId = sender.tab?.windowId;
	if (tabId === undefined || windowId === undefined) {
		return { saved: false, reason: "prototype tab identity is unavailable" };
	}
	try {
		if (!(await activeTabIds(api, windowId)).includes(tabId)) {
			return { saved: false, reason: "prototype tab is no longer active" };
		}
		const captured = await captureVisibleTab(api, windowId);
		// A tab switch during capture would export the newly active page. Keep
		// the image only when the prototype tab is still the one that was captured.
		if (!(await activeTabIds(api, windowId)).includes(tabId)) {
			return { saved: false, reason: "prototype tab is no longer active" };
		}
		const fitted = await fitPreviewDataUrl(captured);
		if (!fitted.dataUrl) {
			return {
				saved: false,
				reason: fitted.reason ?? "preview exceeded the relay size limit and was omitted",
			};
		}
		if (pending.closed) {
			return { saved: false, reason: "prototype request already finished" };
		}
		pending.previewDataUrl = fitted.dataUrl;
		return { saved: true };
	} catch (error) {
		return {
			saved: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Open the marked URL in a new tab and resolve once the content script in that
 * exact tab reports a terminal outcome (style guide, verdict, or not-ready).
 * Correlation is by tabId, never by slug, so concurrent requests cannot cross.
 */
export function requestPrototypeBrowserWork(
	api: ProtoBrowserApi,
	request: ProtoBrowserRequest,
	onProgress: (status: string) => void,
	deadlineMs = protoExtensionDeadlineMs(request.phase, request.timeoutMs),
): Promise<ProtoResultFrame> {
	return new Promise((resolve) => {
		let settled = false;
		let tabId: number | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ProtoResultFrame): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (tabId !== undefined) {
				const pending = pendingByTab.get(tabId);
				if (pending) {
					pending.closed = true;
					pending.previewDataUrl = undefined;
				}
				pendingByTab.delete(tabId);
			}
			resolve(result);
		};
		timer = setTimeout(() => {
			finish({ ok: false, error: PROTO_DEADLINE_ERROR });
		}, deadlineMs);
		if (typeof timer === "object" && timer !== null && "unref" in timer) {
			timer.unref();
		}
		void (async () => {
			const rejected = markedUrlRejection(request.markedUrl);
			if (rejected) {
				finish({ ok: false, error: rejected });
				return;
			}
			let tab: Browser.tabs.Tab;
			try {
				tab = await browserCall(
					api,
					api.tabs.create as MaybeCallbackMethod<unknown[], Browser.tabs.Tab>,
					[{ url: request.markedUrl, active: true }],
				);
			} catch (error) {
				finish({
					ok: false,
					error: `the extension could not open a tab for this URL: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
				return;
			}
			if (settled) {
				// The deadline won while tabs.create was still pending. The tab
				// is otherwise untracked, so close it instead of leaving it open.
				if (tab?.id !== undefined && api.tabs.remove) {
					try {
						await browserCall(
							api,
							api.tabs.remove as MaybeCallbackMethod<unknown[], void>,
							[tab.id],
						);
					} catch {
						// The request already finished. Closing the tab is best-effort.
					}
				}
				return;
			}
			if (tab?.id === undefined) {
				finish({
					ok: false,
					error: "the extension could not open a tab for this URL",
				});
				return;
			}
			tabId = tab.id;
			pendingByTab.set(tabId, { onProgress, resolve: finish });
		})();
	});
}

/** Factory mirroring `createInboxHandler`: one browser-work request per call, correlated by its own tab. */
export function createProtoHandler({
	browserApi,
	deadlineMs,
}: {
	browserApi: ProtoBrowserApi;
	deadlineMs?: number;
}) {
	return (
		request: ProtoBrowserRequest,
		onProgress: (status: string) => void,
	): Promise<ProtoResultFrame> =>
		requestPrototypeBrowserWork(
			browserApi,
			request,
			onProgress,
			deadlineMs,
		);
}

/** Wire the validated content-to-background prototype reports for every open tab's pending request. */
export function registerProto(options: { browserApi?: ProtoBrowserApi } = {}): void {
	const api = options.browserApi ?? (browser as unknown as ProtoBrowserApi);
	api.tabs.onRemoved.addListener((tabId) => {
		const pending = pendingByTab.get(tabId);
		if (!pending) return;
		pending.resolve({
			ok: false,
			error: "The prototype tab was closed before a result.",
		});
	});
	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		const tabId = sender.tab?.id;
		if (tabId === undefined) return undefined;
		if (isMessageOfType(message, PROTO_HAS_PENDING)) {
			sendResponse({ pending: pendingByTab.has(tabId) });
			return undefined;
		}
		const pending = pendingByTab.get(tabId);
		if (!pending) return undefined;

		if (isMessageOfType(message, PROTO_SAVE_STYLE_GUIDE)) {
			try {
				const styleGuide = validateStyleGuide(message.styleGuide);
				pending.resolve({ ok: true, data: { kind: "style-guide", styleGuide } });
			} catch (error) {
				pending.resolve({
					ok: false,
					error: `the extension collected an invalid style guide: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
			return undefined;
		}
		if (isMessageOfType(message, PROTO_SAVE_VERDICT)) {
			try {
				const verdict = validateVerdict(message.verdict);
				pending.resolve({
					ok: true,
					data: {
						kind: "verdict",
						verdict,
						...(pending.previewDataUrl
							? { previewDataUrl: pending.previewDataUrl }
							: {}),
					},
				});
			} catch (error) {
				pending.resolve({
					ok: false,
					error: `the extension collected an invalid verdict: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
			return undefined;
		}
		if (isMessageOfType(message, PROTO_NOT_READY)) {
			try {
				pending.resolve({
					ok: false,
					notReady: validateProtoNotReadyError(message.error),
				});
			} catch {
				pending.resolve({
					ok: false,
					error: "the extension reported an invalid not-ready error",
				});
			}
			return undefined;
		}
		if (isMessageOfType(message, PROTO_PROGRESS)) {
			if (typeof message.status === "string") pending.onProgress(message.status);
			return undefined;
		}
		if (isMessageOfType(message, PROTO_CAPTURE_PREVIEW)) {
			void capturePreview(api, pending, sender).then(sendResponse);
			return true;
		}
		return undefined;
	});
}
