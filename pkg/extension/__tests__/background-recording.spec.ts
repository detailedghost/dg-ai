/**
 * Unit tests for the recording dispatch table in lib/background/recording.ts.
 *
 * Each MSG type routed through the router must invoke exactly the corresponding
 * demo-recorder function. Deps are injected via createRecordingRouter rather than
 * mock.module, since mock.module rewrites the module registry process-wide and
 * would leak into demo-recorder.spec.ts (which imports the real functions).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createRecordingRouter } from "@/lib/background/recording";
import { MSG } from "@/lib/demo-messages";

const stopVideoRecording = mock(() => undefined);
const relayPlayStep = mock((_index: number) => undefined);
const handleClearForCapture = mock(async () => undefined);
const handleRecordingReady = mock(async (_durations: number[]) => undefined);
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
