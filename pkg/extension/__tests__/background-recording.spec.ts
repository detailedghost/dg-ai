/**
 * Unit tests for the recording dispatch table in lib/background/recording.ts.
 *
 * Each MSG type routed through the router must invoke exactly the corresponding
 * demo-recorder function. Deps are injected via createRecordingRouter rather than
 * mock.module, since mock.module rewrites the module registry process-wide and
 * would leak into demo-recorder.spec.ts (which imports the real functions).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	assignedRecordShortcut,
	createRecordingRouter,
	maybeStartRecording,
	RECORD_COMMAND,
	recordingRefusal,
} from "@/lib/background/recording";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";

const stopVideoRecording = mock(async (_tabId: number) => undefined);
const relayPlayStep = mock(async (_tabId: number, _index: number) => undefined);
const relayCaptureCleared = mock(async () => undefined);
const handleClearForCapture = mock(async () => undefined);
const handleRecordingReady = mock(async (_durations: number[]) => undefined);
const handleNarrationComplete = mock(async (_index: number) => undefined);
const handleNarrationProgress = mock(
	async (_progress: number, _label?: string) => undefined,
);
const handleRecordingData = mock(async (_dataUrl: string) => undefined);
const confirmDownload = mock(async (_tabId: number) => undefined);
const discardRecording = mock(async (_tabId: number) => undefined);
const handleRequestVideoData = mock(
	async (
		_tabId: number,
		sendResponse: (data: { dataUrl: string | null }) => void,
	) => {
		sendResponse({ dataUrl: "mocked" });
	},
);

const handleRecordingMessage = createRecordingRouter({
	stopVideoRecording,
	relayPlayStep,
	relayCaptureCleared,
	handleClearForCapture,
	handleRecordingReady,
	handleNarrationComplete,
	handleNarrationProgress,
	handleRecordingData,
	confirmDownload,
	discardRecording,
	handleRequestVideoData,
});

const TAB_ID = 7;
/** Let queued promise callbacks run — the async reply routes land on a later tick. */
const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const sender = { tab: { id: TAB_ID } } as chrome.runtime.MessageSender;
const noopSendResponse = mock(
	(_data: { dataUrl: string | null } | { shortcut: string | null }) =>
		undefined,
);

beforeEach(() => {
	stopVideoRecording.mockClear();
	relayPlayStep.mockClear();
	relayCaptureCleared.mockClear();
	handleClearForCapture.mockClear();
	handleRecordingReady.mockClear();
	handleNarrationComplete.mockClear();
	handleNarrationProgress.mockClear();
	handleRecordingData.mockClear();
	confirmDownload.mockClear();
	discardRecording.mockClear();
	handleRequestVideoData.mockClear();
	noopSendResponse.mockClear();
	(globalThis as unknown as { chrome: unknown }).chrome = {
		runtime: { sendMessage: mock(() => undefined) },
	};
});

describe("handleRecordingMessage", () => {
	it("routes videoStop to stopVideoRecording with the sender's tab id", () => {
		handleRecordingMessage({ type: MSG.videoStop }, sender, noopSendResponse);
		expect(stopVideoRecording).toHaveBeenCalledWith(TAB_ID);
	});

	it("ignores videoStop without a sender tab id", () => {
		const noTabSender = {} as chrome.runtime.MessageSender;
		handleRecordingMessage(
			{ type: MSG.videoStop },
			noTabSender,
			noopSendResponse,
		);
		expect(stopVideoRecording).not.toHaveBeenCalled();
	});

	it("routes playStep with a numeric index to relayPlayStep with the sender's tab id", () => {
		handleRecordingMessage(
			{ type: MSG.playStep, index: 3 },
			sender,
			noopSendResponse,
		);
		expect(relayPlayStep).toHaveBeenCalledWith(TAB_ID, 3);
	});

	it("ignores playStep without a numeric index", () => {
		handleRecordingMessage({ type: MSG.playStep }, sender, noopSendResponse);
		expect(relayPlayStep).not.toHaveBeenCalled();
	});

	it("ignores playStep without a sender tab id", () => {
		const noTabSender = {} as chrome.runtime.MessageSender;
		handleRecordingMessage(
			{ type: MSG.playStep, index: 3 },
			noTabSender,
			noopSendResponse,
		);
		expect(relayPlayStep).not.toHaveBeenCalled();
	});

	it("routes clearForCapture targeting background to handleClearForCapture", () => {
		handleRecordingMessage(
			{ type: MSG.clearForCapture, target: "background" },
			sender,
			noopSendResponse,
		);
		expect(handleClearForCapture).toHaveBeenCalledTimes(1);
	});

	it("ignores clearForCapture not targeting background", () => {
		handleRecordingMessage(
			{ type: MSG.clearForCapture, target: "offscreen" },
			sender,
			noopSendResponse,
		);
		expect(handleClearForCapture).not.toHaveBeenCalled();
	});

	it("relays captureCleared targeting background to the offscreen doc", () => {
		handleRecordingMessage(
			{ type: MSG.captureCleared, target: "background" },
			sender,
			noopSendResponse,
		);
		expect(relayCaptureCleared).toHaveBeenCalledTimes(1);
	});

	it("routes recordingReady targeting background to handleRecordingReady", () => {
		handleRecordingMessage(
			{ type: MSG.recordingReady, target: "background", durations: [1, 2] },
			sender,
			noopSendResponse,
		);
		expect(handleRecordingReady).toHaveBeenCalledWith([1, 2]);
	});

	it("defaults recordingReady durations to [] when absent", () => {
		handleRecordingMessage(
			{ type: MSG.recordingReady, target: "background" },
			sender,
			noopSendResponse,
		);
		expect(handleRecordingReady).toHaveBeenCalledWith([]);
	});

	it("routes narration progress targeting background", () => {
		handleRecordingMessage(
			{
				type: MSG.narrationProgress,
				target: "background",
				progress: 64,
				label: "Synthesizing step 1 of 2",
			},
			sender,
			noopSendResponse,
		);
		expect(handleNarrationProgress).toHaveBeenCalledWith(
			64,
			"Synthesizing step 1 of 2",
		);
	});

	it("routes an indexed narration completion targeting background", () => {
		handleRecordingMessage(
			{
				type: MSG.narrationComplete,
				target: "background",
				index: 3,
			},
			sender,
			noopSendResponse,
		);
		expect(handleNarrationComplete).toHaveBeenCalledWith(3);
	});

	it("routes recordingData with a string dataUrl targeting background to handleRecordingData", () => {
		handleRecordingMessage(
			{ type: MSG.recordingData, target: "background", dataUrl: "data:x" },
			sender,
			noopSendResponse,
		);
		expect(handleRecordingData).toHaveBeenCalledWith("data:x");
	});

	it("ignores recordingData when dataUrl is not a string", () => {
		handleRecordingMessage(
			{ type: MSG.recordingData, target: "background" },
			sender,
			noopSendResponse,
		);
		expect(handleRecordingData).not.toHaveBeenCalled();
	});

	it("routes videoConfirmDownload with a sender tab to confirmDownload", () => {
		handleRecordingMessage(
			{ type: MSG.videoConfirmDownload },
			sender,
			noopSendResponse,
		);
		expect(confirmDownload).toHaveBeenCalledWith(TAB_ID);
	});

	it("routes videoDiscard with a sender tab to discardRecording", () => {
		handleRecordingMessage(
			{ type: MSG.videoDiscard },
			sender,
			noopSendResponse,
		);
		expect(discardRecording).toHaveBeenCalledWith(TAB_ID);
	});

	it("ignores videoConfirmDownload/videoDiscard without a sender tab id", () => {
		const noTabSender = {} as chrome.runtime.MessageSender;
		handleRecordingMessage(
			{ type: MSG.videoConfirmDownload },
			noTabSender,
			noopSendResponse,
		);
		handleRecordingMessage(
			{ type: MSG.videoDiscard },
			noTabSender,
			noopSendResponse,
		);
		expect(confirmDownload).not.toHaveBeenCalled();
		expect(discardRecording).not.toHaveBeenCalled();
	});

	it("special-cases requestVideoData: calls handleRequestVideoData and returns true to keep the channel open", () => {
		const result = handleRecordingMessage(
			{ type: MSG.requestVideoData },
			sender,
			noopSendResponse,
		);
		expect(result).toBe(true);
		expect(handleRequestVideoData).toHaveBeenCalledWith(
			TAB_ID,
			noopSendResponse,
		);
	});

	it("requestVideoData without a sender tab id is not routed", () => {
		const noTabSender = {} as chrome.runtime.MessageSender;
		const result = handleRecordingMessage(
			{ type: MSG.requestVideoData },
			noTabSender,
			noopSendResponse,
		);
		expect(result).toBeUndefined();
		expect(handleRequestVideoData).not.toHaveBeenCalled();
	});

	it("answers requestRecordShortcut from what Chrome assigned, not from the manifest", async () => {
		Object.assign(chrome, {
			commands: {
				getAll: mock(async () => [
					{ name: RECORD_COMMAND, shortcut: "Alt+Shift+K" },
				]),
			},
		});
		const result = handleRecordingMessage(
			{ type: MSG.requestRecordShortcut },
			sender,
			noopSendResponse,
		);
		// true keeps the channel open: the reply lands after the getAll promise settles.
		expect(result).toBe(true);
		await settle();
		expect(noopSendResponse).toHaveBeenCalledWith({ shortcut: "Alt+Shift+K" });
	});

	it("reports no shortcut rather than nothing when the commands read fails", async () => {
		Object.assign(chrome, {
			commands: { getAll: mock(async () => Promise.reject(new Error("nope"))) },
		});
		handleRecordingMessage(
			{ type: MSG.requestRecordShortcut },
			sender,
			noopSendResponse,
		);
		await settle();
		expect(noopSendResponse).toHaveBeenCalledWith({ shortcut: null });
	});
});

describe("assignedRecordShortcut", () => {
	it("returns the shortcut Chrome bound to the record command", () => {
		expect(
			assignedRecordShortcut([
				{ name: "_execute_action", shortcut: "" },
				{ name: RECORD_COMMAND, shortcut: "Alt+Shift+D" },
			]),
		).toBe("Alt+Shift+D");
	});

	// The whole point of asking: a second unpacked copy of this extension holding the
	// combo leaves ours assigned an empty string, so the keypress never arrives here.
	it("treats an empty assignment as no shortcut at all", () => {
		expect(
			assignedRecordShortcut([{ name: RECORD_COMMAND, shortcut: "" }]),
		).toBeNull();
	});

	it("returns null when the command is absent entirely", () => {
		expect(
			assignedRecordShortcut([{ name: "_execute_action", shortcut: "Alt+P" }]),
		).toBeNull();
	});
});

describe("recordingRefusal", () => {
	const excludedSetupVideo: TourScript = {
		startUrl: "https://app.example",
		mode: "video",
		setup: {
			includeInTour: false,
			steps: [{ body: "Prepare", action: { do: "click" } }],
		},
		steps: [{ body: "Tour" }],
	};

	it("keeps excluded setup outside capture until tutorial handoff", () => {
		expect(
			recordingRefusal({
				script: excludedSetupVideo,
				phase: "setup",
				setupActionsApproved: true,
			}),
		).toMatch(/setup steps first/);
		expect(
			recordingRefusal({
				script: excludedSetupVideo,
				phase: "tutorial",
				setupActionsApproved: true,
			}),
		).toBeNull();
	});

	it("blocks recording setup actions until explicit approval", () => {
		expect(
			recordingRefusal({
				script: excludedSetupVideo,
				phase: "tutorial",
			}),
		).toMatch(/[Aa]pprove/);
		expect(
			recordingRefusal({
				script: excludedSetupVideo,
				phase: "tutorial",
				setupActionsApproved: true,
			}),
		).toBeNull();
	});

	// Every refusal has to name itself: this is the gesture the user was told to press.
	it("gives a distinct reason for each way it can decline", () => {
		const reasons = [
			recordingRefusal(undefined),
			recordingRefusal({ script: excludedSetupVideo, phase: "setup" }),
			recordingRefusal({ script: excludedSetupVideo, phase: "tutorial" }),
		];
		expect(reasons.every((r) => typeof r === "string" && r.length > 0)).toBe(
			true,
		);
		expect(new Set(reasons).size).toBe(3);
	});
});

describe("maybeStartRecording", () => {
	const tab: chrome.tabs.Tab = {
		id: TAB_ID,
		index: 0,
		pinned: false,
		highlighted: true,
		groupId: -1,
		windowId: 1,
		active: true,
		frozen: false,
		incognito: false,
		selected: true,
		discarded: false,
		autoDiscardable: true,
	};
	const tutorialActionVideo: TourScript = {
		startUrl: "https://app.example",
		mode: "video",
		steps: [{ body: "Tour", action: { do: "click" } }],
	};

	it("fails closed at the actual start call site for missing/invalid phase or consent", async () => {
		const startRecording = mock(
			async (_tabId: number, _script: TourScript) => undefined,
		);
		const sendMessage = mock((_tabId: number, _msg: unknown) => undefined);
		const blockedStates = [
			{ script: tutorialActionVideo, automaticActionsApproved: true },
			{
				script: tutorialActionVideo,
				phase: "invalid",
				automaticActionsApproved: true,
			},
			{
				script: tutorialActionVideo,
				phase: "tutorial",
				setupActionsApproved: true,
			},
		];

		for (const state of blockedStates) {
			Object.assign(chrome, {
				tabs: { sendMessage },
				storage: {
					local: {
						get: mock(async () => ({ [`demo_tour:${TAB_ID}`]: state })),
					},
				},
			});
			expect(await maybeStartRecording(tab, startRecording)).toBe(true);
		}

		expect(startRecording).not.toHaveBeenCalled();
		// Refusing quietly is the bug: Alt+Shift+D did nothing and said nothing.
		expect(sendMessage).toHaveBeenCalledTimes(blockedStates.length);
		for (const [, msg] of sendMessage.mock.calls) {
			const blocked = msg as { type: string; reason: string };
			expect(blocked.type).toBe(MSG.videoBlocked);
			expect(blocked.reason.length).toBeGreaterThan(0);
		}
	});

	it("says nothing to a tab that has no video tour, so the toolbar opens settings", async () => {
		const startRecording = mock(
			async (_tabId: number, _script: TourScript) => undefined,
		);
		const sendMessage = mock((_tabId: number, _msg: unknown) => undefined);
		Object.assign(chrome, {
			tabs: { sendMessage },
			storage: {
				local: {
					get: mock(async () => ({
						[`demo_tour:${TAB_ID}`]: {
							script: { ...tutorialActionVideo, mode: "walkthrough" },
							phase: "tutorial",
						},
					})),
				},
			},
		});

		expect(await maybeStartRecording(tab, startRecording)).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("starts only after tutorial phase and all-action consent are persisted", async () => {
		const startRecording = mock(
			async (_tabId: number, _script: TourScript) => undefined,
		);
		Object.assign(chrome, {
			storage: {
				local: {
					get: mock(async () => ({
						[`demo_tour:${TAB_ID}`]: {
							script: tutorialActionVideo,
							phase: "tutorial",
							automaticActionsApproved: true,
						},
					})),
				},
			},
		});

		expect(await maybeStartRecording(tab, startRecording)).toBe(true);
		expect(startRecording).toHaveBeenCalledWith(TAB_ID, tutorialActionVideo);
	});

	/** Storage stub keyed by request: demo_tour:<tab> vs the single active-recording slot. */
	function stubKeyedStorage(
		activeRecording: unknown,
		storageRemove = mock(async () => undefined),
	) {
		return {
			get: mock(async (key: string) => {
				if (key === `demo_tour:${TAB_ID}`) {
					return {
						[`demo_tour:${TAB_ID}`]: {
							script: tutorialActionVideo,
							phase: "tutorial",
							automaticActionsApproved: true,
						},
					};
				}
				if (key === "demo_active_recording")
					return { demo_active_recording: activeRecording };
				return {};
			}),
			set: mock(async () => undefined),
			remove: storageRemove,
		};
	}

	/**
	 * The regression a single-active guard almost reintroduced: acquireStreamId's
	 * retry path closes the shared offscreen document, which would destroy tab A's
	 * live recording if ever called for a start that's going to be refused anyway.
	 * The conflict must be decided — and must refuse — before startRecording runs.
	 */
	it("refuses a different, still-open tab's start without ever acquiring a stream or touching the offscreen doc", async () => {
		const sendMessage = mock((_tabId: number, _msg: unknown) => undefined);
		const getMediaStreamId = mock(async () => "stream-id");
		const closeDocument = mock(async () => undefined);
		const OTHER_TAB_ID = 999;
		Object.assign(chrome, {
			tabs: { sendMessage, get: mock(async (id: number) => ({ id })) },
			tabCapture: { getMediaStreamId },
			offscreen: { closeDocument, createDocument: mock(async () => undefined) },
			storage: {
				local: stubKeyedStorage({
					tabId: OTHER_TAB_ID,
					tour: "Other",
					hideBody: false,
					planMarkdown: "",
				}),
			},
		});

		// No startRecording override: the real startVideoRecording must never run.
		expect(await maybeStartRecording(tab)).toBe(true);

		expect(sendMessage).toHaveBeenCalledWith(
			TAB_ID,
			expect.objectContaining({ type: MSG.videoBlocked }),
		);
		expect(getMediaStreamId).not.toHaveBeenCalled();
		expect(closeDocument).not.toHaveBeenCalled();
	});

	it("treats a stale active-recording slot (its tab is gone) as free: drops it and lets the start proceed", async () => {
		const startRecording = mock(
			async (_tabId: number, _script: TourScript) => undefined,
		);
		const storageRemove = mock(async () => undefined);
		Object.assign(chrome, {
			tabs: {
				get: mock(async () => {
					throw new Error("No tab with id");
				}),
			},
			storage: {
				local: stubKeyedStorage(
					{ tabId: 999, tour: "Other", hideBody: false, planMarkdown: "" },
					storageRemove,
				),
			},
		});

		expect(await maybeStartRecording(tab, startRecording)).toBe(true);
		expect(storageRemove).toHaveBeenCalledWith("demo_active_recording");
		expect(startRecording).toHaveBeenCalledWith(TAB_ID, tutorialActionVideo);
	});
});
