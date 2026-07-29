/**
 * Unit tests for Slice 2 — background-video-review-flow.
 *
 * Tests: handleRecordingData, confirmDownload, discardRecording,
 * handleRequestVideoData from demo-recorder.ts.
 *
 * chrome.* APIs are hand-rolled stubs on globalThis. IDB is shimmed via
 * fake-indexeddb, reset per test so no state leaks between cases.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import {
	activeRecordingRefusal,
	confirmDownload,
	discardRecording,
	handleNarrationComplete,
	handleNarrationProgress,
	handleRecordingData,
	handleRecordingTabClosed,
	handleRequestVideoData,
	relayPlayStep,
	startVideoRecording,
	stopVideoRecording,
} from "@/lib/features/demo-recorder";
import { getRecording, saveRecording } from "@/utils/recording-db";

// ---------------------------------------------------------------------------
// Chrome stub helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendMessage: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let downloadMock: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storageData: Record<string, any>;
let mockLastError: { message?: string } | undefined;
let downloadShouldFail: boolean;

const TAB_ID = 42;

const ACTIVE_RECORDING = {
	tabId: TAB_ID,
	tour: "My Tour",
	hideBody: false,
	planMarkdown: "# Plan",
};
const readConfig = async () => ({
	color: "random" as const,
	voice: "af_heart",
	narration: "both" as const,
});

function buildChromeStub() {
	sendMessage = mock((..._args: unknown[]) => undefined);
	downloadShouldFail = false;
	downloadMock = mock((opts: unknown, cb?: (id?: number) => void) => {
		if (downloadShouldFail) {
			mockLastError = { message: "Download failed" };
			cb?.(undefined);
			mockLastError = undefined;
		} else {
			cb?.(42);
		}
	});

	(globalThis as any).chrome = {
		tabs: {
			sendMessage,
			// Resolves by default (tab exists); tests simulating a closed tab override this.
			get: mock(async (id: number) => ({ id })),
		},
		tabCapture: { getMediaStreamId: mock(async () => "stream-id") },
		offscreen: {
			closeDocument: mock(async () => undefined),
			createDocument: mock(async () => undefined),
		},
		downloads: { download: downloadMock },
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
			onMessage: {
				addListener: mock(() => undefined),
				removeListener: mock(() => undefined),
			},
			sendMessage: mock(() => undefined),
			get lastError() {
				return mockLastError;
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

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

	// ── handleRecordingData ──────────────────────────────────────────────────

	describe("handleRecordingData", () => {
		it("valid dataUrl: downloads.download NOT called; MSG.videoReview sent to tab; IDB entry exists with correct slug and dataUrl", async () => {
			const dataUrl = "data:video/webm;base64,AAAA";

			await handleRecordingData(dataUrl);

			expect(downloadMock).not.toHaveBeenCalled();
			expect(sendMessage).toHaveBeenCalledWith(TAB_ID, {
				type: MSG.videoReview,
			});

			const entry = await getRecording(TAB_ID);
			expect(entry).toBeDefined();
			expect(entry?.tabId).toBe(TAB_ID);
			expect(entry?.dataUrl).toBe(dataUrl);
			expect(entry?.slug).toBe("my-tour");
		});

		it("empty string: MSG.videoError sent; IDB empty; no download call", async () => {
			await handleRecordingData("");

			expect(downloadMock).not.toHaveBeenCalled();
			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoError }),
			);

			const entry = await getRecording(TAB_ID);
			expect(entry).toBeUndefined();
		});
	});

	// ── confirmDownload ──────────────────────────────────────────────────────

	describe("confirmDownload", () => {
		it("downloads the video and the plan as two separate files under dg-demo/<slug>/; IDB entry absent after success", async () => {
			const dataUrl = "data:video/webm;base64,AAAA";
			await saveRecording({
				tabId: TAB_ID,
				dataUrl,
				slug: "my-tour",
				planMarkdown: "# Plan",
				createdAt: Date.now(),
			});

			await confirmDownload(TAB_ID);

			expect(downloadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "dg-demo/my-tour/my-tour.webm",
					url: dataUrl,
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
			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoSaved }),
			);

			const entry = await getRecording(TAB_ID);
			expect(entry).toBeUndefined();
		});

		it("passes the stored dataUrl straight through with no base64 decode", async () => {
			const dataUrl = "data:video/webm;base64,SGVsbG8=";
			await saveRecording({
				tabId: TAB_ID,
				dataUrl,
				slug: "my-tour",
				planMarkdown: "# Plan",
				createdAt: Date.now(),
			});

			await confirmDownload(TAB_ID);

			const videoCall = downloadMock.mock.calls.find(
				(call: unknown[]) =>
					(call[0] as { filename: string }).filename ===
					"dg-demo/my-tour/my-tour.webm",
			);
			expect(videoCall?.[0]).toMatchObject({ url: dataUrl });
		});

		it("missing IDB entry: sends MSG.videoError; download not called", async () => {
			await confirmDownload(TAB_ID);

			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoError }),
			);
			expect(downloadMock).not.toHaveBeenCalled();
		});
	});

	// ── discardRecording ─────────────────────────────────────────────────────

	describe("discardRecording", () => {
		it("IDB entry absent after call", async () => {
			await saveRecording({
				tabId: TAB_ID,
				dataUrl: "data:video/webm;base64,AAAA",
				slug: "demo",
				planMarkdown: "",
				createdAt: Date.now(),
			});

			await discardRecording(TAB_ID);

			expect(await getRecording(TAB_ID)).toBeUndefined();
		});

		it("no crash if entry was never there", async () => {
			await expect(discardRecording(TAB_ID)).resolves.toBeUndefined();
		});
	});

	// ── handleRequestVideoData ───────────────────────────────────────────────

	describe("handleRequestVideoData", () => {
		it("sendResponse called with stored dataUrl when entry is present", async () => {
			await saveRecording({
				tabId: TAB_ID,
				dataUrl: "data:video/webm;base64,PAYLOAD",
				slug: "demo",
				planMarkdown: "",
				createdAt: Date.now(),
			});

			const sendResponse = mock(
				(_data: { dataUrl: string | null }) => undefined,
			);
			await handleRequestVideoData(TAB_ID, sendResponse);

			expect(sendResponse).toHaveBeenCalledWith({
				dataUrl: "data:video/webm;base64,PAYLOAD",
			});
		});

		it("sendResponse called with { dataUrl: null } when entry is absent", async () => {
			const sendResponse = mock(
				(_data: { dataUrl: string | null }) => undefined,
			);
			await handleRequestVideoData(TAB_ID, sendResponse);

			expect(sendResponse).toHaveBeenCalledWith({ dataUrl: null });
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
		it("chrome.runtime.lastError set → sends MSG.videoError; both downloads still attempted; IDB entry is still removed", async () => {
			await saveRecording({
				tabId: TAB_ID,
				dataUrl: "data:video/webm;base64,AAAA",
				slug: "demo",
				planMarkdown: "",
				createdAt: Date.now(),
			});

			downloadShouldFail = true;
			await confirmDownload(TAB_ID);

			expect(downloadMock).toHaveBeenCalledTimes(2);
			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoError }),
			);
			expect(await getRecording(TAB_ID)).toBeUndefined();
		});
	});

	describe("discardRecording — isolation", () => {
		it("removes ONLY the targeted tabId, leaves others intact", async () => {
			await saveRecording({
				tabId: 1,
				dataUrl: "url1",
				slug: "s1",
				planMarkdown: "",
				createdAt: Date.now(),
			});
			await saveRecording({
				tabId: 2,
				dataUrl: "url2",
				slug: "s2",
				planMarkdown: "",
				createdAt: Date.now(),
			});
			await saveRecording({
				tabId: 3,
				dataUrl: "url3",
				slug: "s3",
				planMarkdown: "",
				createdAt: Date.now(),
			});

			await discardRecording(2);

			expect(await getRecording(1)).toBeDefined();
			expect(await getRecording(2)).toBeUndefined();
			expect(await getRecording(3)).toBeDefined();
		});
	});

	describe("handleRecordingData — slug computation", () => {
		it("computes slug correctly for tour name with spaces and punctuation ('My Demo Tour!')", async () => {
			storageData["demo_active_recording"] = {
				tabId: TAB_ID,
				tour: "My Demo Tour!",
				hideBody: false,
				planMarkdown: "# Plan",
			};

			await handleRecordingData("data:video/webm;base64,AAAA");

			const entry = await getRecording(TAB_ID);
			expect(entry?.slug).toBe("my-demo-tour-");
		});
	});
});
