/**
 * Unit tests for Slice 2 — background-video-review-flow.
 *
 * Tests: handleRecordingData, confirmDownload, discardRecording,
 * handleRequestVideoData from demo-recorder.ts.
 *
 * chrome.* APIs are hand-rolled stubs on globalThis. IDB is shimmed via
 * fake-indexeddb, reset per test so no state leaks between cases.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import { saveRecording, getRecording } from "@/utils/recording-db";
import {
	handleRecordingData,
	confirmDownload,
	discardRecording,
	handleRequestVideoData,
} from "@/lib/features/demo-recorder";
import { MSG } from "@/lib/demo-messages";

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
		tabs: { sendMessage },
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
		it("reads IDB, calls downloads.download with filename matching dg-demo/<slug>/<slug>.zip; IDB entry absent after success", async () => {
			await saveRecording({
				tabId: TAB_ID,
				dataUrl: "data:video/webm;base64,AAAA",
				slug: "my-tour",
				planMarkdown: "# Plan",
				createdAt: Date.now(),
			});

			await confirmDownload(TAB_ID);

			expect(downloadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "dg-demo/my-tour/my-tour.zip",
				}),
				expect.any(Function),
			);
			expect(sendMessage).toHaveBeenCalledWith(
				TAB_ID,
				expect.objectContaining({ type: MSG.videoSaved }),
			);

			const entry = await getRecording(TAB_ID);
			expect(entry).toBeUndefined();
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

			const sendResponse = mock((_data: { dataUrl: string | null }) => undefined);
			await handleRequestVideoData(TAB_ID, sendResponse);

			expect(sendResponse).toHaveBeenCalledWith({
				dataUrl: "data:video/webm;base64,PAYLOAD",
			});
		});

		it("sendResponse called with { dataUrl: null } when entry is absent", async () => {
			const sendResponse = mock((_data: { dataUrl: string | null }) => undefined);
			await handleRequestVideoData(TAB_ID, sendResponse);

			expect(sendResponse).toHaveBeenCalledWith({ dataUrl: null });
		});
	});

	// ── GREEN: coverage gap tests ────────────────────────────────────────────

	describe("confirmDownload — download failure", () => {
		it("chrome.runtime.lastError set → sends MSG.videoError; IDB entry is still removed", async () => {
			await saveRecording({
				tabId: TAB_ID,
				dataUrl: "data:video/webm;base64,AAAA",
				slug: "demo",
				planMarkdown: "",
				createdAt: Date.now(),
			});

			downloadShouldFail = true;
			await confirmDownload(TAB_ID);

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
