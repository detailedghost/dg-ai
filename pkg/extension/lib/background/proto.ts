import {
	canonicalizeStyleGuide,
	validateProtoIdentifier,
	validateStyleGuide,
	validateVerdict,
} from "@dg/common";
import { type Browser, browser } from "wxt/browser";
import { callBrowserApi } from "@/lib/browser-call";
import {
	PROTO_CAPTURE_PREVIEW,
	PROTO_SAVE_STYLE_GUIDE,
	PROTO_SAVE_VERDICT,
} from "@/lib/features/prototype";

type SaveStyleGuideMessage = {
	type: typeof PROTO_SAVE_STYLE_GUIDE;
	slug: string;
	styleGuide: unknown;
};

type SaveVerdictMessage = {
	type: typeof PROTO_SAVE_VERDICT;
	verdict: unknown;
};

type CapturePreviewMessage = {
	type: typeof PROTO_CAPTURE_PREVIEW;
	slug: string;
};

/** Injectable browser seams and timing used to register prototype handoffs. */
export type RegisterProtoOptions = {
	previewDownloadTimeoutMs?: number;
	browserApi?: ProtoBrowserApi;
};

const DEFAULT_PREVIEW_DOWNLOAD_TIMEOUT_MS = 30_000;

type MaybeCallbackMethod<TArgs extends unknown[], TResult> = (
	...args: [...TArgs, ((value: TResult) => void)?]
) => PromiseLike<TResult> | void;

/** Browser API surface required by prototype downloads and preview capture. */
export type ProtoBrowserApi = {
	downloads: {
		download: MaybeCallbackMethod<[Browser.downloads.DownloadOptions], number>;
		onChanged?: {
			addListener(
				callback: (delta: Browser.downloads.DownloadDelta) => void,
			): void;
			removeListener(
				callback: (delta: Browser.downloads.DownloadDelta) => void,
			): void;
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
	tabs: {
		captureVisibleTab: MaybeCallbackMethod<
			[number, Browser.extensionTypes.ImageDetails],
			string
		>;
		query: MaybeCallbackMethod<[Browser.tabs.QueryInfo], Browser.tabs.Tab[]>;
	};
};

function isSaveStyleGuideMessage(
	message: unknown,
): message is SaveStyleGuideMessage {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as Record<string, unknown>;
	if (candidate.type !== PROTO_SAVE_STYLE_GUIDE) return false;
	try {
		validateProtoIdentifier(candidate.slug, "style guide payload.slug");
		return true;
	} catch {
		return false;
	}
}

function isSaveVerdictMessage(message: unknown): message is SaveVerdictMessage {
	if (typeof message !== "object" || message === null) return false;
	return (message as Record<string, unknown>).type === PROTO_SAVE_VERDICT;
}

function isCapturePreviewMessage(
	message: unknown,
): message is CapturePreviewMessage {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as Record<string, unknown>;
	if (candidate.type !== PROTO_CAPTURE_PREVIEW) return false;
	try {
		validateProtoIdentifier(candidate.slug, "preview payload.slug");
		return true;
	} catch {
		return false;
	}
}

/** Download options for a validated guide, preserving the payload's exact slug. */
export function styleGuideDownloadOptions(message: SaveStyleGuideMessage) {
	const guide = validateStyleGuide(message.styleGuide);
	const json = canonicalizeStyleGuide(guide);
	return {
		url: `data:application/json;charset=utf-8,${encodeURIComponent(json)}`,
		filename: `dg-proto/${message.slug}/style-guide.json`,
		conflictAction: "overwrite" as const,
	};
}

/** Download options for a fully validated approve/reject verdict. */
export function verdictDownloadOptions(message: SaveVerdictMessage) {
	const verdict = validateVerdict(message.verdict);
	return {
		url: `data:application/json;charset=utf-8,${encodeURIComponent(
			`${JSON.stringify(verdict, null, 2)}\n`,
		)}`,
		filename: `dg-proto/${verdict.slug}/verdict.json`,
		conflictAction: "overwrite" as const,
	};
}

/** Download options for a capability-checked visible-tab PNG. */
export function previewDownloadOptions(slug: string, dataUrl: string) {
	validateProtoIdentifier(slug, "preview payload.slug");
	if (!dataUrl.startsWith("data:image/png")) {
		throw new TypeError("prototype preview must be a PNG data URL");
	}
	return {
		url: dataUrl,
		filename: `dg-proto/${slug}/preview.png`,
		conflictAction: "overwrite" as const,
	};
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

/**
 * Start a preview download and wait until Chrome reports that exact item as
 * complete. The listener is installed first so tiny data URLs cannot finish
 * before the returned download ID is assigned.
 */
function downloadPreview(
	api: ProtoBrowserApi,
	options: Browser.downloads.DownloadOptions,
	timeoutMs: number,
): Promise<void> {
	const changes = api.downloads?.onChanged;
	if (
		typeof api.downloads?.download !== "function" ||
		typeof changes?.addListener !== "function" ||
		typeof changes?.removeListener !== "function"
	) {
		return Promise.reject(
			new Error(
				"prototype preview download completion tracking is unsupported",
			),
		);
	}

	return new Promise((resolve, reject) => {
		let downloadId: number | undefined;
		let settled = false;
		const terminalDeltas = new Map<number, Browser.downloads.DownloadDelta>();
		const errors = new Map<number, string>();
		let timeout: ReturnType<typeof setTimeout>;

		const cleanup = (): void => {
			clearTimeout(timeout);
			changes.removeListener(onChanged);
		};
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const inspect = (delta: Browser.downloads.DownloadDelta): void => {
			if (delta.error?.current) errors.set(delta.id, delta.error.current);
			const state = delta.state?.current;
			if (state !== "complete" && state !== "interrupted") return;
			if (downloadId === undefined) {
				terminalDeltas.set(delta.id, delta);
				return;
			}
			if (delta.id !== downloadId) return;
			if (state === "complete") {
				finish();
				return;
			}
			const reason = delta.error?.current ?? errors.get(delta.id);
			finish(
				new Error(
					`prototype preview download ${downloadId} was interrupted${reason ? `: ${reason}` : ""}`,
				),
			);
		};
		const onChanged = (delta: Browser.downloads.DownloadDelta): void => {
			inspect(delta);
		};

		changes.addListener(onChanged);
		timeout = setTimeout(() => {
			finish(
				new Error(
					downloadId === undefined
						? "timed out waiting for prototype preview download to start"
						: `timed out waiting for prototype preview download ${downloadId} to complete`,
				),
			);
		}, timeoutMs);

		let started: Promise<number>;
		try {
			started = browserCall(
				api,
				api.downloads.download as MaybeCallbackMethod<unknown[], number>,
				[options],
			);
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		void started.then(
			(id) => {
				downloadId = id;
				const buffered = terminalDeltas.get(id);
				if (buffered) inspect(buffered);
			},
			(error) => {
				finish(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

async function savePreview(
	api: ProtoBrowserApi,
	message: CapturePreviewMessage,
	sender: Browser.runtime.MessageSender,
	timeoutMs: number,
): Promise<{ saved: boolean; reason?: string }> {
	if (typeof api.tabs?.captureVisibleTab !== "function") {
		return { saved: false, reason: "visible-tab capture is unsupported" };
	}
	const tabId = sender.tab?.id;
	const windowId = sender.tab?.windowId;
	if (tabId === undefined || windowId === undefined) {
		return { saved: false, reason: "prototype tab identity is unavailable" };
	}
	try {
		const senderTabIsActive = async (): Promise<boolean> => {
			const activeTabs = await browserCall(
				api,
				api.tabs.query as MaybeCallbackMethod<unknown[], Browser.tabs.Tab[]>,
				[{ active: true, windowId }],
			);
			return activeTabs.some((tab) => tab.id === tabId);
		};
		if (!(await senderTabIsActive())) {
			return {
				saved: false,
				reason: "prototype tab is no longer active",
			};
		}
		const dataUrl = await captureVisibleTab(api, windowId);
		// Re-check before persistence so a tab switch racing the capture can
		// never save a preview from a different active tab.
		if (!(await senderTabIsActive())) {
			return {
				saved: false,
				reason: "prototype tab changed during preview capture",
			};
		}
		await downloadPreview(
			api,
			previewDownloadOptions(message.slug, dataUrl),
			timeoutMs,
		);
		return { saved: true };
	} catch (error) {
		return {
			saved: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function observeDownload(
	label: "style guide" | "verdict",
	download: Promise<number>,
): void {
	void download.catch((error) => {
		console.error(`[dg-ai-extension] ${label} download failed:`, error);
	});
}

/** Wire the validated content-to-background prototype download handoffs. */
export function registerProto(options: RegisterProtoOptions = {}): void {
	const previewDownloadTimeoutMs =
		options.previewDownloadTimeoutMs ?? DEFAULT_PREVIEW_DOWNLOAD_TIMEOUT_MS;
	const api = options.browserApi ?? (browser as unknown as ProtoBrowserApi);
	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (isSaveStyleGuideMessage(message)) {
			try {
				observeDownload(
					"style guide",
					browserCall(
						api,
						api.downloads.download as MaybeCallbackMethod<unknown[], number>,
						[styleGuideDownloadOptions(message)],
					),
				);
			} catch (error) {
				console.error("[dg-ai-extension] style guide download failed:", error);
			}
			return;
		}
		if (isSaveVerdictMessage(message)) {
			try {
				observeDownload(
					"verdict",
					browserCall(
						api,
						api.downloads.download as MaybeCallbackMethod<unknown[], number>,
						[verdictDownloadOptions(message)],
					),
				);
			} catch (error) {
				console.error("[dg-ai-extension] verdict download failed:", error);
			}
			return;
		}
		if (!isCapturePreviewMessage(message)) return;
		void savePreview(api, message, sender, previewDownloadTimeoutMs).then(
			sendResponse,
		);
		return true;
	});
}
