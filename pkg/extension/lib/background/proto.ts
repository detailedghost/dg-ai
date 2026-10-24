import {
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
	onProgress: (status: string) => void;
	previewDataUrl?: string;
	resolve: (result: ProtoResultFrame) => void;
};

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

async function captureVisibleTab(
	api: ProtoBrowserApi,
	windowId: number,
): Promise<string> {
	const dataUrl = await browserCall(
		api,
		api.tabs.captureVisibleTab as MaybeCallbackMethod<unknown[], string>,
		[windowId, { format: "png" }],
	);
	if (!dataUrl) throw new Error("capture returned no image");
	return dataUrl;
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
		const activeTabs = await browserCall(
			api,
			api.tabs.query as MaybeCallbackMethod<unknown[], Browser.tabs.Tab[]>,
			[{ active: true, windowId }],
		);
		if (!activeTabs.some((tab) => tab.id === tabId)) {
			return { saved: false, reason: "prototype tab is no longer active" };
		}
		pending.previewDataUrl = await captureVisibleTab(api, windowId);
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
): Promise<ProtoResultFrame> {
	return new Promise((resolve) => {
		let settled = false;
		let tabId: number | undefined;
		const finish = (result: ProtoResultFrame): void => {
			if (settled) return;
			settled = true;
			if (tabId !== undefined) pendingByTab.delete(tabId);
			resolve(result);
		};
		void (async () => {
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
}: {
	browserApi: ProtoBrowserApi;
}) {
	return (
		request: ProtoBrowserRequest,
		onProgress: (status: string) => void,
	): Promise<ProtoResultFrame> =>
		requestPrototypeBrowserWork(browserApi, request, onProgress);
}

/** Wire the validated content-to-background prototype reports for every open tab's pending request. */
export function registerProto(options: { browserApi?: ProtoBrowserApi } = {}): void {
	const api = options.browserApi ?? (browser as unknown as ProtoBrowserApi);
	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		const tabId = sender.tab?.id;
		if (tabId === undefined) return undefined;
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
