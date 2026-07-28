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
	createRecordingRouter,
	maybeStartRecording,
	recordingRefusal,
} from "@/lib/background/recording";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";

const stopVideoRecording = mock(() => undefined);
const relayPlayStep = mock((_index: number) => undefined);
const handleClearForCapture = mock(async () => undefined);
const handleRecordingReady = mock(async (_durations: number[]) => undefined);
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
	handleClearForCapture,
	handleRecordingReady,
	handleNarrationProgress,
	handleRecordingData,
	confirmDownload,
	discardRecording,
	handleRequestVideoData,
});

const TAB_ID = 7;
const sender = { tab: { id: TAB_ID } } as chrome.runtime.MessageSender;
const noopSendResponse = mock((_data: { dataUrl: string | null }) => undefined);

beforeEach(() => {
	stopVideoRecording.mockClear();
	relayPlayStep.mockClear();
	handleClearForCapture.mockClear();
	handleRecordingReady.mockClear();
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
	it("routes videoStop to stopVideoRecording", () => {
		handleRecordingMessage({ type: MSG.videoStop }, sender, noopSendResponse);
		expect(stopVideoRecording).toHaveBeenCalledTimes(1);
	});

	it("routes playStep with a numeric index to relayPlayStep", () => {
		handleRecordingMessage(
			{ type: MSG.playStep, index: 3 },
			sender,
			noopSendResponse,
		);
		expect(relayPlayStep).toHaveBeenCalledWith(3);
	});

	it("ignores playStep without a numeric index", () => {
		handleRecordingMessage({ type: MSG.playStep }, sender, noopSendResponse);
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
		expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
			type: MSG.captureCleared,
			target: "offscreen",
		});
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
});
