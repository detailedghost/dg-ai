/**
 * Unit tests for the background half of the video-review flow.
 *
 * Tests: handleRecordingSaved, confirmDownload, discardRecording,
 * handleReviewTabClosed from demo-recorder.ts, plus the recording lifecycle.
 *
 * chrome.* APIs are hand-rolled stubs on globalThis. IDB is shimmed via
 * fake-indexeddb, reset per test so no state leaks between cases — and because
 * `recording-db.ts` runs for real here, recordings are stored as actual `Blob`s.
 *
 * The offscreen document is faked through `runtime.sendMessage`: it is the only
 * context that can mint an object URL, so `offscreenReplies` is what stands in for
 * it. `settleDownload` drives `downloads.onChanged`, which is how the code learns a
 * download finished and its URL may be released.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import {
	activeRecordingRefusal,
	confirmDownload,
	discardRecording,
	HANDOFF_ATTEMPTS,
	HANDOFF_BACKOFF_MS,
	handleNarrationComplete,
	handleNarrationProgress,
	handleRecordingSaved,
	handleRecordingTabClosed,
	handleReviewTabClosed,
	relayPlayStep,
	startVideoRecording,
	stopVideoRecording,
	warmNarration,
} from "@/lib/features/demo-recorder";
import {
	getRecording,
	hasRecording,
	saveRecording,
} from "@/utils/recording-db";

// ── chrome stub helpers ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendMessage: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let downloadMock: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runtimeSendMessage: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tabsCreate: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storageData: Record<string, any>;
let mockLastError: { message?: string } | undefined;
let downloadShouldFail: boolean;
/** Canned offscreen answers by message type — the stand-in for that document. */
let offscreenReplies: Record<string, unknown>;
let downloadListeners: Array<(delta: chrome.downloads.DownloadDelta) => void>;

const TAB_ID = 42;
const REVIEW_TAB_ID = 77;
const DOWNLOAD_ID = 42;
const BLOB_URL = "blob:chrome-extension://abc/deadbeef";

/** Real wall-clock the exhausted-handoff path spends in backoff, plus headroom. */
const HANDOFF_LADDER_MS =
	(HANDOFF_BACKOFF_MS * (HANDOFF_ATTEMPTS - 1) * HANDOFF_ATTEMPTS) / 2;
const EXHAUSTED_HANDOFF_TIMEOUT_MS = HANDOFF_LADDER_MS * 5;

const ACTIVE_RECORDING = { tabId: TAB_ID, hideBody: false };
const readConfig = async () => ({
	color: "random" as const,
	voice: "af_heart",
	narration: "both" as const,
	videoQuality: "1440p" as const,
	theme: "dark" as const,
});

/** A stored recording, with a real Blob rather than a string stand-in. */
function storeRecording(overrides?: {
	tabId?: number;
	slug?: string;
	planMarkdown?: string;
}): Promise<void> {
	return saveRecording({
		tabId: overrides?.tabId ?? TAB_ID,
		blob: new Blob(["AAAA"], { type: "video/webm" }),
		slug: overrides?.slug ?? "my-tour",
		planMarkdown: overrides?.planMarkdown ?? "# Plan",
		createdAt: Date.now(),
	});
}

/** Let unawaited follow-up work (the revoke bookkeeping) run before asserting. */
const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

/** Drive downloads.onChanged the way Chrome does when a download ends. */
function settleDownload(
	state: "complete" | "interrupted",
	id = DOWNLOAD_ID,
): void {
	for (const listener of [...downloadListeners])
		listener({ id, state: { current: state, previous: "in_progress" } });
}

function buildChromeStub() {
	sendMessage = mock((..._args: unknown[]) => undefined);
	downloadShouldFail = false;
	downloadListeners = [];
	offscreenReplies = { [MSG.mintBlobUrl]: { url: BLOB_URL } };
	downloadMock = mock((_opts: unknown, cb?: (id?: number) => void) => {
		if (downloadShouldFail) {
			mockLastError = { message: "Download failed" };
			cb?.(undefined);
			mockLastError = undefined;
		} else {
			cb?.(DOWNLOAD_ID);
		}
	});
	runtimeSendMessage = mock(
		async (msg: { type?: string }) => offscreenReplies[msg?.type ?? ""],
	);
	tabsCreate = mock(async (_opts: unknown) => ({ id: REVIEW_TAB_ID }));

	(globalThis as any).chrome = {
		tabs: {
			sendMessage,
			create: tabsCreate,
			// Resolves by default (tab exists); tests simulating a closed tab override this.
			get: mock(async (id: number) => ({ id })),
		},
		tabCapture: { getMediaStreamId: mock(async () => "stream-id") },
		offscreen: {
			closeDocument: mock(async () => undefined),
			createDocument: mock(async () => undefined),
		},
		downloads: {
			download: downloadMock,
			onChanged: {
				addListener: mock(
					(fn: (delta: chrome.downloads.DownloadDelta) => void) => {
						downloadListeners.push(fn);
					},
				),
				removeListener: mock(
					(fn: (delta: chrome.downloads.DownloadDelta) => void) => {
						downloadListeners = downloadListeners.filter((l) => l !== fn);
					},
				),
			},
		},
		storage: {
			local: {
				get: mock(async (key: string | string[]) => {
					if (typeof key === "string") return { [key]: storageData[key] };
					const result: Record<string, any> = {};
					const ks = Array.isArray(key) ? key : [key];
					for (const k of ks) result[k] = storageData[k];
					return result;
				}),
				set: mock(async (items: Record<string, any>) => {
					Object.assign(storageData, items);
				}),
				remove: mock(async (keys: string | string[]) => {
					const ks = Array.isArray(keys) ? keys : [keys];
					for (const k of ks) delete storageData[k];
				}),
			},
		},
		runtime: {
			getContexts: mock(async () => []),
			getURL: mock((path: string) => `chrome-extension://abc/${path}`),
			onMessage: {
				addListener: mock(() => undefined),
				removeListener: mock(() => undefined),
			},
			sendMessage: runtimeSendMessage,
			get lastError() {
				return mockLastError;
			},
		},
	};
}

// ── suite ───────────────────────────────────────────────────────────────────

describe("demo-recorder", () => {
	beforeEach(() => {
		// Fresh IDB namespace per test.
		(globalThis as any).indexedDB = new IDBFactory();
		(globalThis as any).IDBKeyRange = FakeIDBKeyRange;

		mockLastError = undefined;

		storageData = {
			demo_active_recording: { ...ACTIVE_RECORDING },
		};

		buildChromeStub();
	});

	// ── handleRecordingSaved ─────────────────────────────────────────────────

	describe("handleRecordingSaved", () => {
		it("opens the review page in its own tab, carrying the recording's tab id", async () => {
			await handleRecordingSaved(true);

			expect(tabsCreate).toHaveBeenCalledWith({
				url: `chrome-extension://abc/review.html?tab=${TAB_ID}`,
			});
			expect(downloadMock).not.toHaveBeenCalled();
		});

		it("remembers which review tab is showing which recording", async () => {
			await handleRecordingSaved(true);

			expect(storageData.demo_review_tab).toEqual({
				reviewTabId: REVIEW_TAB_ID,
				tabId: TAB_ID,
			});
		});

		it("frees the recording slot so the next tour can record", async () => {
			await handleRecordingSaved(true);

			expect(storageData.demo_active_recording).toBeUndefined();
		});

		it("saved: false reports the failure to the tour tab and opens no review tab", async () => {
			await handleRecordingSaved(false, "recording did not start");

			expect(tabsCreate).not.toHaveBeenCalled();
			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoError,
				error: "recording did not start",
			});
			expect(storageData.demo_active_recording).toBeUndefined();
		});

		it("saved: false without a reason still says something the tour tab can show", async () => {
			await handleRecordingSaved(false);

			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoError }),
			);
		});

		it("a review tab that cannot be opened surfaces as an error, not a frozen tour", async () => {
			tabsCreate.mockImplementation(async () => {
				throw new Error("no window");
			});

			await handleRecordingSaved(true);

			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoError }),
			);
		});
	});

	// ── confirmDownload ──────────────────────────────────────────────────────

	describe("confirmDownload", () => {
		it("downloads the video and the plan as two separate files under dg-demo/<slug>/; IDB entry absent after success", async () => {
			await storeRecording();

			const result = await confirmDownload(TAB_ID);

			expect(result).toEqual({ ok: true, folder: "dg-demo/my-tour" });
			expect(downloadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "dg-demo/my-tour/my-tour.webm",
					url: BLOB_URL,
				}),
				expect.any(Function),
			);
			expect(downloadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "dg-demo/my-tour/my-tour.demo.md",
				}),
				expect.any(Function),
			);
			expect(downloadMock).toHaveBeenCalledTimes(2);

			expect(await getRecording(TAB_ID)).toBeUndefined();
		});

		it("downloads the video from an object URL minted by the offscreen document", async () => {
			// The bytes never reach the worker: it asks the one context that can make a
			// URL for them, and hands the downloads API that string.
			await storeRecording();

			await confirmDownload(TAB_ID);

			expect(runtimeSendMessage).toHaveBeenCalledWith({
				type: MSG.mintBlobUrl,
				tabId: TAB_ID,
				target: "offscreen",
			});
			const videoCall = downloadMock.mock.calls.find(
				(call: unknown[]) =>
					(call[0] as { filename: string }).filename ===
					"dg-demo/my-tour/my-tour.webm",
			);
			expect(videoCall?.[0]).toMatchObject({ url: BLOB_URL });
		});

		it("stands the tour tab down once the files are on disk", async () => {
			await storeRecording();

			await confirmDownload(TAB_ID);

			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoSaved,
				filename: "dg-demo/my-tour",
			});
		});

		it("forgets the review-tab pairing, so closing that tab does not re-arm the tour", async () => {
			storageData.demo_review_tab = {
				reviewTabId: REVIEW_TAB_ID,
				tabId: TAB_ID,
			};
			await storeRecording();

			await confirmDownload(TAB_ID);

			expect(storageData.demo_review_tab).toBeUndefined();
		});

		it("missing IDB entry: reports the failure and never starts a download", async () => {
			const result = await confirmDownload(TAB_ID);

			expect(result).toEqual({ ok: false, error: "no recording found" });
			expect(downloadMock).not.toHaveBeenCalled();
		});

		it("a recorder that cannot mint a URL fails without deleting the recording", async () => {
			await storeRecording();
			offscreenReplies = { [MSG.mintBlobUrl]: { url: null } };

			const result = await confirmDownload(TAB_ID);

			expect(result.ok).toBe(false);
			expect(downloadMock).not.toHaveBeenCalled();
			expect(await hasRecording(TAB_ID)).toBe(true);
		});
	});

	// ── confirmDownload: releasing the object URL ────────────────────────────

	describe("confirmDownload — object URL lifetime", () => {
		it("does not release the URL when the download is merely created", async () => {
			// The create callback fires before Chrome has read the bytes; revoking there
			// truncates exactly the large files a higher preset produces.
			await storeRecording();

			await confirmDownload(TAB_ID);
			await flush();

			expect(runtimeSendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.revokeBlobUrl }),
			);
		});

		it("releases the URL once the download completes", async () => {
			await storeRecording();
			await confirmDownload(TAB_ID);

			settleDownload("complete");
			await flush();

			expect(runtimeSendMessage).toHaveBeenCalledWith({
				type: MSG.revokeBlobUrl,
				url: BLOB_URL,
				target: "offscreen",
			});
		});

		it("releases the URL when the download is interrupted, rather than leaking it", async () => {
			await storeRecording();
			await confirmDownload(TAB_ID);

			settleDownload("interrupted");
			await flush();

			expect(runtimeSendMessage).toHaveBeenCalledWith({
				type: MSG.revokeBlobUrl,
				url: BLOB_URL,
				target: "offscreen",
			});
		});

		it("ignores state changes belonging to a different download", async () => {
			await storeRecording();
			await confirmDownload(TAB_ID);

			settleDownload("complete", DOWNLOAD_ID + 1);
			await flush();

			expect(runtimeSendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.revokeBlobUrl }),
			);
		});

		it("stops listening to downloads.onChanged once the URL is released", async () => {
			await storeRecording();
			await confirmDownload(TAB_ID);

			settleDownload("complete");
			await flush();

			expect(downloadListeners).toHaveLength(0);
		});
	});

	// ── discardRecording ─────────────────────────────────────────────────────

	describe("discardRecording", () => {
		it("IDB entry absent after call", async () => {
			await storeRecording({ slug: "demo" });

			await discardRecording(TAB_ID);

			expect(await getRecording(TAB_ID)).toBeUndefined();
		});

		it("tells the tour tab to re-arm, which is where another take starts", async () => {
			await storeRecording();

			const result = await discardRecording(TAB_ID);

			expect(result).toEqual({ ok: true });
			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoRearm,
			});
		});

		it("re-arms even when the entry was already gone — a stranded tour tab is the worse outcome", async () => {
			const result = await discardRecording(TAB_ID);

			expect(result).toEqual({ ok: false });
			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoRearm,
			});
		});

		it("forgets the review-tab pairing", async () => {
			storageData.demo_review_tab = {
				reviewTabId: REVIEW_TAB_ID,
				tabId: TAB_ID,
			};

			await discardRecording(TAB_ID);

			expect(storageData.demo_review_tab).toBeUndefined();
		});
	});

	// ── handleReviewTabClosed ────────────────────────────────────────────────

	describe("handleReviewTabClosed", () => {
		beforeEach(() => {
			storageData.demo_review_tab = {
				reviewTabId: REVIEW_TAB_ID,
				tabId: TAB_ID,
			};
		});

		it("re-arms the tour tab when the review was abandoned with the recording still there", async () => {
			await storeRecording();

			await handleReviewTabClosed(REVIEW_TAB_ID);

			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoRearm,
			});
		});

		it("leaves the abandoned recording in place rather than destroying it", async () => {
			await storeRecording();

			await handleReviewTabClosed(REVIEW_TAB_ID);

			expect(await hasRecording(TAB_ID)).toBe(true);
		});

		it("does nothing when the recording was already acted on", async () => {
			// Download and discard both clear the entry, so nothing left means nothing owed.
			await handleReviewTabClosed(REVIEW_TAB_ID);

			expect(sendMessage).not.toHaveBeenCalled();
		});

		it("ignores an unrelated tab closing", async () => {
			await storeRecording();

			await handleReviewTabClosed(REVIEW_TAB_ID + 1);

			expect(sendMessage).not.toHaveBeenCalled();
			expect(storageData.demo_review_tab).toBeDefined();
		});

		it("clears the pairing so a recycled tab id cannot re-trigger it", async () => {
			await handleReviewTabClosed(REVIEW_TAB_ID);

			expect(storageData.demo_review_tab).toBeUndefined();
		});
	});

	describe("startVideoRecording", () => {
		/**
		 * getMediaStreamId consumes the user gesture: any await ahead of it risks
		 * Chrome reporting "Extension has not been invoked for the current page"
		 * (a bug this file has shipped twice — once by omission, once by a
		 * single-active guard placed ahead of it here before being moved out to
		 * maybeStartRecording). A stub can't reproduce gesture invalidation itself,
		 * but it can pin the one thing that actually causes it: call order.
		 */
		it("acquires the stream id before any other await in the function", async () => {
			const order: string[] = [];
			(globalThis as any).chrome.tabCapture.getMediaStreamId = mock(
				async () => {
					order.push("getMediaStreamId");
					return "stream-id";
				},
			);
			(globalThis as any).chrome.runtime.getContexts = mock(async () => {
				order.push("ensureOffscreen");
				return [];
			});
			const realSet = chrome.storage.local.set;
			(globalThis as any).chrome.storage.local.set = mock(
				async (items: Record<string, any>) => {
					order.push("storage.set");
					return realSet(items);
				},
			);
			const script: TourScript = {
				startUrl: "https://app.example",
				mode: "video",
				steps: [{ body: "Show dashboard" }],
			};

			await startVideoRecording(TAB_ID, script, readConfig);

			expect(order).toEqual([
				"getMediaStreamId",
				"ensureOffscreen",
				"storage.set",
			]);
		});

		it("sends included setup before tutorial steps so narration indexes match recorded playback", async () => {
			const script: TourScript = {
				title: "Setup demo",
				startUrl: "https://app.example",
				mode: "video",
				setup: {
					steps: [{ body: "Sign in" }, { body: "Seed a record" }],
					includeInTour: true,
				},
				steps: [{ body: "Show dashboard" }, { body: "Open details" }],
			};
			await startVideoRecording(TAB_ID, script, readConfig);

			expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.startRecording,
					steps: [
						{ body: "Sign in" },
						{ body: "Seed a record" },
						{ body: "Show dashboard" },
						{ body: "Open details" },
					],
				}),
			);
		});

		it("does not send excluded setup to the recorder", async () => {
			const script: TourScript = {
				startUrl: "https://app.example",
				mode: "video",
				setup: { steps: [{ body: "Sign in" }], includeInTour: false },
				steps: [{ body: "Show dashboard" }],
			};
			await startVideoRecording(TAB_ID, script, readConfig);

			expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.startRecording,
					steps: [{ body: "Show dashboard" }],
				}),
			);
		});

		/**
		 * The offscreen document can exist before its module script is listening. An
		 * unawaited send swallowed that rejection, and the tour then sat on the
		 * preparation modal forever with no video and no error to explain it.
		 */
		it("retries the offscreen handoff until the recorder is listening", async () => {
			const script: TourScript = {
				startUrl: "https://app.example",
				mode: "video",
				steps: [{ body: "Show dashboard" }],
			};
			let attempts = 0;
			(globalThis as any).chrome.runtime.sendMessage = mock(async () => {
				attempts++;
				if (attempts < 3)
					throw new Error(
						"Could not establish connection. Receiving end does not exist.",
					);
				return { ok: true };
			});

			await startVideoRecording(TAB_ID, script, readConfig);

			expect(attempts).toBe(3);
			// State survives a retried handoff: cleanup here would kill the whole tour.
			expect(storageData["demo_active_recording"]).toBeDefined();
		});

		it("rejects (so the gesture reports it) when the recorder never answers", async () => {
			const script: TourScript = {
				startUrl: "https://app.example",
				mode: "video",
				steps: [{ body: "Show dashboard" }],
			};
			(globalThis as any).chrome.runtime.sendMessage = mock(async () => {
				throw new Error("Receiving end does not exist.");
			});

			await expect(
				startVideoRecording(TAB_ID, script, readConfig),
			).rejects.toThrow(/offscreen recorder never answered/);
			// A dead handoff must not leave the active-recording marker behind, or the
			// next attempt inherits a recording that was never running.
			expect(storageData["demo_active_recording"]).toBeUndefined();
		});

		it("shows determinate narration preparation before starting offscreen work", async () => {
			const script: TourScript = {
				startUrl: "https://app.example",
				mode: "video",
				steps: [{ body: "Show dashboard" }],
			};
			await startVideoRecording(TAB_ID, script, readConfig);

			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoPreparing,
				narrate: true,
			});
		});
	});

	describe("activeRecordingRefusal", () => {
		it("allows the start when no recording is active", async () => {
			delete storageData["demo_active_recording"];

			expect(await activeRecordingRefusal(TAB_ID)).toBeNull();
		});

		it("allows the same tab that already holds the slot to start again", async () => {
			// beforeEach seeds demo_active_recording with tabId: TAB_ID.
			expect(await activeRecordingRefusal(TAB_ID)).toBeNull();
		});

		it("refuses a different tab while the recording tab is still open", async () => {
			const reason = await activeRecordingRefusal(999);

			expect(reason).toMatch(/already recording/);
		});

		it("treats a different tab's slot as stale once that tab is gone, clears it, and allows the start", async () => {
			// A service-worker restart or browser crash can strand ACTIVE_KEY on a tab
			// that onRemoved never got a chance to clear.
			(globalThis as any).chrome.tabs.get = mock(async () => {
				throw new Error("No tab with id: 999");
			});

			expect(await activeRecordingRefusal(999)).toBeNull();
			expect(storageData["demo_active_recording"]).toBeUndefined();
		});
	});

	describe("handleRecordingTabClosed", () => {
		it("clears the active recording when its own tab closes", async () => {
			await handleRecordingTabClosed(TAB_ID);

			expect(storageData["demo_active_recording"]).toBeUndefined();
			expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
		});

		it("leaves the active recording alone when a different tab closes", async () => {
			await handleRecordingTabClosed(999);

			expect(storageData["demo_active_recording"]).toBeDefined();
		});

		// The regression this whole guard exists to prevent: closing the recording
		// tab must free the slot, or every later start is refused forever.
		it("frees the slot on tab close so a different tab is not refused", async () => {
			await handleRecordingTabClosed(TAB_ID);

			expect(await activeRecordingRefusal(7)).toBeNull();
		});
	});

	describe("stopVideoRecording", () => {
		it("ignores a stop from a tab that is not the active recording", async () => {
			await stopVideoRecording(999);

			expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.stopRecording }),
			);
		});

		it("forwards the stop to the offscreen recorder for the active tab", async () => {
			await stopVideoRecording(TAB_ID);

			expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.stopRecording,
					target: "offscreen",
				}),
			);
		});
	});

	describe("relayPlayStep", () => {
		it("ignores a play-step cue from a tab that is not the active recording", async () => {
			await relayPlayStep(999, 2);

			expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.playStep }),
			);
		});

		it("forwards the play-step cue to the offscreen recorder for the active tab", async () => {
			await relayPlayStep(TAB_ID, 2);

			expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.playStep,
					index: 2,
					target: "offscreen",
				}),
			);
		});
	});

	describe("handleNarrationProgress", () => {
		it("clamps and forwards progress to the active tour tab", async () => {
			await handleNarrationProgress(104.6, "Narration ready");

			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.narrationProgress,
				progress: 100,
				label: "Narration ready",
			});
		});
	});

	describe("handleNarrationComplete", () => {
		it("forwards the completed step index to the active tour tab", async () => {
			await handleNarrationComplete(2);

			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.narrationComplete,
				index: 2,
			});
		});

		it("emits from the audio source onended event with the same step index", async () => {
			const { relayNarrationCompletionOnEnd } = await import(
				"@/entrypoints/offscreen/main"
			);
			const source = {} as AudioBufferSourceNode;
			relayNarrationCompletionOnEnd(source, 4);

			source.onended?.({} as Event);

			expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
				type: MSG.narrationComplete,
				target: "background",
				index: 4,
			});
		});
	});

	// ── Additional behavior ─────────────────────────────────────────────────

	describe("confirmDownload — download failure", () => {
		it("chrome.runtime.lastError set → reports the failure; both downloads still attempted", async () => {
			await storeRecording({ slug: "demo", planMarkdown: "" });

			downloadShouldFail = true;
			const result = await confirmDownload(TAB_ID);

			expect(downloadMock).toHaveBeenCalledTimes(2);
			expect(result).toEqual({ ok: false, error: "Download failed" });
		});

		it("keeps the recording on failure, so Download can simply be pressed again", async () => {
			// Dropping the entry here used to be the behaviour; with review in its own
			// tab that would cost the user the whole take instead of one retry.
			await storeRecording({ slug: "demo", planMarkdown: "" });

			downloadShouldFail = true;
			await confirmDownload(TAB_ID);

			expect(await hasRecording(TAB_ID)).toBe(true);
		});

		it("leaves the tour tab alone on failure — it is not finished with yet", async () => {
			await storeRecording({ slug: "demo", planMarkdown: "" });

			downloadShouldFail = true;
			await confirmDownload(TAB_ID);

			expect(sendMessage).not.toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoSaved }),
			);
		});

		it("releases the object URL even though the download never started", async () => {
			await storeRecording({ slug: "demo", planMarkdown: "" });

			downloadShouldFail = true;
			await confirmDownload(TAB_ID);
			await flush();

			expect(runtimeSendMessage).toHaveBeenCalledWith({
				type: MSG.revokeBlobUrl,
				url: BLOB_URL,
				target: "offscreen",
			});
		});
	});

	describe("discardRecording — isolation", () => {
		it("removes ONLY the targeted tabId, leaves others intact", async () => {
			await storeRecording({ tabId: 1, slug: "s1", planMarkdown: "" });
			await storeRecording({ tabId: 2, slug: "s2", planMarkdown: "" });
			await storeRecording({ tabId: 3, slug: "s3", planMarkdown: "" });

			await discardRecording(2);

			expect(await getRecording(1)).toBeDefined();
			expect(await getRecording(2)).toBeUndefined();
			expect(await getRecording(3)).toBeDefined();
		});
	});

	// ── narration warm-up ────────────────────────────────────────────────────

	describe("warmNarration", () => {
		it("creates the offscreen document and tells it to load the model", async () => {
			await warmNarration(readConfig);

			expect(chrome.offscreen.createDocument).toHaveBeenCalled();
			expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.warmNarration,
					target: "offscreen",
				}),
			);
		});

		// Captions-only never synthesizes, so warming it downloads ~90 MB for nothing.
		it("skips silent mode entirely, touching no offscreen document", async () => {
			const captionsOnly = async () => ({
				...(await readConfig()),
				narration: "captions" as const,
			});

			await warmNarration(captionsOnly);

			expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
			expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
		});

		/**
		 * A warm-up runs on a message the tour is waiting on, well before the user has
		 * committed to recording. Throwing here would abort a tour to save a few seconds
		 * the recorder's own load path can still spend.
		 */
		it(
			"resolves rather than throwing when the offscreen document is unreachable",
			async () => {
				const unreachable = mock(async () => {
					throw new Error("Receiving end does not exist.");
				});
				(globalThis as any).chrome.runtime.sendMessage = unreachable;

				await expect(warmNarration(readConfig)).resolves.toBeUndefined();
				expect(unreachable).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS);
			},
			EXHAUSTED_HANDOFF_TIMEOUT_MS,
		);

		it("resolves when the config read fails", async () => {
			const brokenConfig = async () => {
				throw new Error("sync storage unavailable");
			};

			await expect(warmNarration(brokenConfig as any)).resolves.toBeUndefined();
		});
	});

	// ── warm-document lifecycle ──────────────────────────────────────────────

	/**
	 * The narration model is cached for the offscreen document's lifetime, so closing
	 * that document after every recording is what forced every recording to reload it.
	 * A finished recorder has already stopped its own tracks, so what is left behind
	 * holds no stream to block the next start.
	 */
	describe("offscreen reuse across recordings", () => {
		it("keeps the document alive after a finished recording", async () => {
			await handleRecordingSaved(true);

			expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
			// The slot itself must still be freed, or the next recording is refused.
			expect(storageData["demo_active_recording"]).toBeUndefined();
		});

		it("keeps the document alive when the recorder aborted with no video", async () => {
			await handleRecordingSaved(false);

			expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
			expect(storageData["demo_active_recording"]).toBeUndefined();
		});

		// A closed tab may still be being captured, and only closing the doc stops that.
		it("still closes the document when the recording tab disappears", async () => {
			await handleRecordingTabClosed(TAB_ID);

			expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
		});

		// An unacknowledged handoff means the document is broken, not warm.
		it("still closes the document when the handoff is never acknowledged", async () => {
			(globalThis as any).chrome.runtime.sendMessage = mock(async () => {
				throw new Error("Receiving end does not exist.");
			});
			const script: TourScript = {
				startUrl: "https://app.example",
				mode: "video",
				steps: [{ body: "Show dashboard" }],
			};

			await expect(
				startVideoRecording(TAB_ID, script, readConfig),
			).rejects.toThrow();

			expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
		});
	});

	/**
	 * The recorder writes the IDB entry itself, so everything that entry needs has to
	 * travel out with the start handoff — nothing comes back but a "saved" flag.
	 */
	describe("startVideoRecording — the entry the recorder will write", () => {
		const videoScript = (title?: string): TourScript => ({
			startUrl: "https://app.example",
			mode: "video",
			...(title === undefined ? {} : { title }),
			steps: [{ body: "Show dashboard" }],
		});

		it("hands over the tab id, slug, and plan markdown", async () => {
			await startVideoRecording(
				TAB_ID,
				videoScript("My Demo Tour!"),
				readConfig,
			);

			expect(runtimeSendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.startRecording,
					tabId: TAB_ID,
					slug: "my-demo-tour-",
					planMarkdown: expect.stringContaining("Show dashboard"),
				}),
			);
		});

		it("hands over the configured video quality, which decides capture size", async () => {
			// Nothing downstream can recover it: the constraint is applied at getUserMedia.
			await startVideoRecording(TAB_ID, videoScript("My Tour"), readConfig);

			expect(runtimeSendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.startRecording,
					quality: "1440p",
				}),
			);
		});

		it("falls back to a 'demo' slug for an untitled tour", async () => {
			await startVideoRecording(TAB_ID, videoScript(), readConfig);

			expect(runtimeSendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.startRecording, slug: "demo" }),
			);
		});

		it("keeps only the fields the tour tab still needs in the active-recording record", async () => {
			await startVideoRecording(TAB_ID, videoScript("My Tour"), readConfig);

			expect(storageData.demo_active_recording).toEqual({
				tabId: TAB_ID,
				hideBody: false,
			});
		});
	});
});
