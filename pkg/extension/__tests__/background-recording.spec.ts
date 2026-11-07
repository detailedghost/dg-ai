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
import { MSG as CHAT_MSG } from "@dg/pages/chat-messages";
import { type DownloadResult, MSG } from "@/lib/demo-messages";
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
const handleRecordingSaved = mock(
	async (_saved: boolean, _error?: string) => undefined,
);
const confirmDownload = mock(
	async (_tabId: number) =>
		({ ok: true, folder: "dg-demo/mocked" }) as DownloadResult,
);
const discardRecording = mock(async (_tabId: number) => ({ ok: true }));
const warmNarration = mock(async () => undefined);

const handleRecordingMessage = createRecordingRouter({
	stopVideoRecording,
	relayPlayStep,
	relayCaptureCleared,
	handleClearForCapture,
	handleRecordingReady,
	handleNarrationComplete,
	handleNarrationProgress,
	handleRecordingSaved,
	confirmDownload,
	discardRecording,
	warmNarration,
});

const TAB_ID = 7;
/** The review tab's own id — deliberately not the recording's, which is the trap. */
const REVIEW_TAB_ID = 99;
/** Let queued promise callbacks run — the async reply routes land on a later tick. */
const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const sender = { tab: { id: TAB_ID } } as chrome.runtime.MessageSender;
/** A message arriving from the review tab, which is a different tab entirely. */
const reviewSender = {
	tab: { id: REVIEW_TAB_ID },
} as chrome.runtime.MessageSender;
const noopSendResponse = mock(
	(_data: DownloadResult | { ok: boolean } | { shortcut: string | null }) =>
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
	handleRecordingSaved.mockClear();
	confirmDownload.mockClear();
	discardRecording.mockClear();
	warmNarration.mockClear();
	noopSendResponse.mockClear();
	(globalThis as unknown as { chrome: unknown }).chrome = {
		runtime: { sendMessage: mock(() => undefined) },
		offscreen: { createDocument: mock(async () => undefined) },
		tabCapture: { getMediaStreamId: mock(async () => "stream-id") },
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

	it("routes recordingSaved targeting background to handleRecordingSaved", () => {
		handleRecordingMessage(
			{ type: MSG.recordingSaved, target: "background", saved: true },
			sender,
			noopSendResponse,
		);
		expect(handleRecordingSaved).toHaveBeenCalledWith(true, undefined);
	});

	it("passes the recorder's failure reason through to handleRecordingSaved", () => {
		handleRecordingMessage(
			{
				type: MSG.recordingSaved,
				target: "background",
				saved: false,
				error: "recording did not start",
			},
			sender,
			noopSendResponse,
		);
		expect(handleRecordingSaved).toHaveBeenCalledWith(
			false,
			"recording did not start",
		);
	});

	it("ignores recordingSaved when saved is not a boolean", () => {
		handleRecordingMessage(
			{ type: MSG.recordingSaved, target: "background" },
			sender,
			noopSendResponse,
		);
		expect(handleRecordingSaved).not.toHaveBeenCalled();
	});

	/**
	 * The review routes must read the tab id from the payload. Falling back to
	 * `sender.tab.id` would look correct and act on the review tab's own id, which no
	 * recording is ever keyed by — a silent no-op rather than a visible failure.
	 */
	it("routes videoConfirmDownload to the tab id in the payload, not the sender's", async () => {
		const result = handleRecordingMessage(
			{ type: MSG.videoConfirmDownload, tabId: TAB_ID },
			reviewSender,
			noopSendResponse,
		);
		expect(result).toBe(true);
		expect(confirmDownload).toHaveBeenCalledWith(TAB_ID);
		expect(confirmDownload).not.toHaveBeenCalledWith(REVIEW_TAB_ID);
		await settle();
		expect(noopSendResponse).toHaveBeenCalledWith({
			ok: true,
			folder: "dg-demo/mocked",
		});
	});

	it("routes videoDiscard to the tab id in the payload, not the sender's", async () => {
		const result = handleRecordingMessage(
			{ type: MSG.videoDiscard, tabId: TAB_ID },
			reviewSender,
			noopSendResponse,
		);
		expect(result).toBe(true);
		expect(discardRecording).toHaveBeenCalledWith(TAB_ID);
		expect(discardRecording).not.toHaveBeenCalledWith(REVIEW_TAB_ID);
		await settle();
		expect(noopSendResponse).toHaveBeenCalledWith({ ok: true });
	});

	it("ignores videoConfirmDownload/videoDiscard with no tab id in the payload", () => {
		handleRecordingMessage(
			{ type: MSG.videoConfirmDownload },
			reviewSender,
			noopSendResponse,
		);
		handleRecordingMessage(
			{ type: MSG.videoDiscard },
			reviewSender,
			noopSendResponse,
		);
		expect(confirmDownload).not.toHaveBeenCalled();
		expect(discardRecording).not.toHaveBeenCalled();
	});

	it("answers the review tab even when the download handler rejects", async () => {
		// An unanswered sendMessage leaves the review tab's button disabled forever.
		confirmDownload.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		handleRecordingMessage(
			{ type: MSG.videoConfirmDownload, tabId: TAB_ID },
			reviewSender,
			noopSendResponse,
		);
		await settle();
		expect(noopSendResponse).toHaveBeenCalledWith(
			expect.objectContaining({ ok: false }),
		);
	});

	it("answers the review tab even when the discard handler rejects", async () => {
		discardRecording.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		handleRecordingMessage(
			{ type: MSG.videoDiscard, tabId: TAB_ID },
			reviewSender,
			noopSendResponse,
		);
		await settle();
		expect(noopSendResponse).toHaveBeenCalledWith({ ok: false });
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

	/**
	 * The shortcut request is the tour about to render "press this to record", which is
	 * typically a whole setup phase ahead of the keypress — the last free moment to
	 * absorb the model load before the user is left watching a progress modal.
	 */
	it("starts the narration warm-up when a tour asks for the record shortcut", async () => {
		Object.assign(chrome, {
			commands: { getAll: mock(async () => []) },
		});

		handleRecordingMessage(
			{ type: MSG.requestRecordShortcut },
			sender,
			noopSendResponse,
		);
		await settle();

		expect(warmNarration).toHaveBeenCalled();
	});

	it("still answers the shortcut when the warm-up rejects", async () => {
		Object.assign(chrome, {
			commands: {
				getAll: mock(async () => [
					{ name: RECORD_COMMAND, shortcut: "Alt+Shift+K" },
				]),
			},
		});
		warmNarration.mockImplementationOnce(async () => {
			throw new Error("offscreen unavailable");
		});

		handleRecordingMessage(
			{ type: MSG.requestRecordShortcut },
			sender,
			noopSendResponse,
		);
		await settle();

		expect(noopSendResponse).toHaveBeenCalledWith({ shortcut: "Alt+Shift+K" });
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
		lastAccessed: 0,
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

	it("says nothing to a tab that has no video tour", async () => {
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

describe("recordDemo message from the popup", () => {
	const POPUP_TAB_ID = 42;
	const popupSender = {
		url: "chrome-extension://test-ext/popup.html",
	} as chrome.runtime.MessageSender;
	const videoTour: TourScript = {
		startUrl: "https://app.example",
		mode: "video",
		steps: [{ body: "Tour" }],
	};
	const startVideoRecording = mock(
		async (_tabId: number, _script: TourScript) => undefined,
	);
	const sendResponse = mock((_data: unknown) => undefined);
	const sendTabMessage = mock((_tabId: number, _msg: unknown) => undefined);
	const tabsGet = mock(async (id: number) => ({ id }));

	const router = createRecordingRouter({
		stopVideoRecording,
		relayPlayStep,
		relayCaptureCleared,
		handleClearForCapture,
		handleRecordingReady,
		handleNarrationComplete,
		handleNarrationProgress,
		handleRecordingSaved,
		confirmDownload,
		discardRecording,
		warmNarration,
		startVideoRecording,
	} as never);

	function stubChrome(options: { state?: unknown; active?: unknown } = {}) {
		const state =
			"state" in options
				? options.state
				: { script: videoTour, phase: "tutorial" };
		Object.assign(chrome, {
			runtime: {
				...chrome.runtime,
				getURL: (path: string) => `chrome-extension://test-ext/${path}`,
			},
			tabs: { sendMessage: sendTabMessage, get: tabsGet },
			commands: {
				getAll: mock(async () => [
					{ name: RECORD_COMMAND, shortcut: "Alt+Shift+D" },
				]),
			},
			storage: {
				local: {
					get: mock(async (key: string) => {
						if (key === `demo_tour:${POPUP_TAB_ID}`)
							return { [key]: state };
						if (key === "demo_active_recording")
							return { [key]: options.active };
						return {};
					}),
					set: mock(async () => undefined),
					remove: mock(async () => undefined),
				},
			},
		});
	}

	async function ask(
		sender: chrome.runtime.MessageSender = popupSender,
		tabId: number = POPUP_TAB_ID,
	) {
		router({ type: CHAT_MSG.recordDemo, tabId } as never, sender, sendResponse);
		await settle();
	}

	beforeEach(() => {
		startVideoRecording.mockClear();
		sendResponse.mockClear();
		sendTabMessage.mockClear();
		tabsGet.mockClear();
		startVideoRecording.mockImplementation(async () => undefined);
	});

	it("starts recording the popup-supplied tab and replies started", async () => {
		stubChrome();

		await ask();

		expect(tabsGet).toHaveBeenCalledWith(POPUP_TAB_ID);
		expect(startVideoRecording).toHaveBeenCalledTimes(1);
		expect(startVideoRecording.mock.calls[0]?.[0]).toBe(POPUP_TAB_ID);
		expect(startVideoRecording.mock.calls[0]?.[1]).toEqual(videoTour);
		expect(sendResponse).toHaveBeenCalledWith({ outcome: "started" });
	});

	it("replies no-tour for a tab that is not running a video tour", async () => {
		stubChrome({
			state: { script: { ...videoTour, mode: "walkthrough" }, phase: "tutorial" },
		});

		await ask();

		expect(sendResponse).toHaveBeenCalledWith({ outcome: "no-tour" });
		expect(startVideoRecording).not.toHaveBeenCalled();
	});

	it("replies no-tour for a tab with no stored tour at all", async () => {
		stubChrome({ state: undefined });

		await ask();

		expect(sendResponse).toHaveBeenCalledWith({ outcome: "no-tour" });
		expect(startVideoRecording).not.toHaveBeenCalled();
	});

	it.each([
		["the tab lookup rejects", () => Promise.reject(new Error("No tab with id"))],
		["the looked-up tab has no id", () => Promise.resolve({})],
	])("replies refused instead of no-tour when %s", async (_name, lookup) => {
		stubChrome();
		tabsGet.mockImplementationOnce(lookup as never);

		await ask();

		expect(sendResponse).toHaveBeenCalledWith({
			outcome: "refused",
			reason: "That tab is no longer open.",
		});
		expect(startVideoRecording).not.toHaveBeenCalled();
	});

	it("replies refused with the tour's refusal reason", async () => {
		const state = { script: videoTour, phase: "setup" as const };
		stubChrome({ state });

		await ask();

		const reason = recordingRefusal(state);
		expect(reason).not.toBeNull();
		expect(sendResponse).toHaveBeenCalledWith({ outcome: "refused", reason });
		expect(startVideoRecording).not.toHaveBeenCalled();
	});

	it("replies refused when another tab is mid-recording", async () => {
		stubChrome({
			active: { tabId: 999, hideBody: false },
		});

		await ask();

		expect(sendResponse).toHaveBeenCalledTimes(1);
		const reply = sendResponse.mock.calls[0]?.[0] as {
			outcome: string;
			reason: string;
		};
		expect(reply.outcome).toBe("refused");
		expect(reply.reason.length).toBeGreaterThan(0);
		expect(startVideoRecording).not.toHaveBeenCalled();
	});

	it("replies capture-failed with the assigned shortcut when the capture start throws", async () => {
		stubChrome();
		startVideoRecording.mockImplementation(async () => {
			throw new Error("Extension has not been invoked for the current page");
		});

		await ask();

		expect(sendResponse).toHaveBeenCalledWith({
			outcome: "capture-failed",
			shortcut: "Alt+Shift+D",
		});
	});

	it.each([
		["a content script tab", { tab: { id: 5 }, url: "https://example.com/" }],
		["a content script tab inside the extension origin", { tab: { id: 5 }, url: "chrome-extension://test-ext/review.html" }],
		["a web page url", { url: "https://example.com/" }],
		["an empty sender", {}],
	])("refuses a recordDemo from %s and starts nothing", async (_name, sender) => {
		stubChrome();

		await ask(sender as chrome.runtime.MessageSender);

		expect(startVideoRecording).not.toHaveBeenCalled();
		expect(tabsGet).not.toHaveBeenCalled();
		expect(sendResponse).not.toHaveBeenCalledWith({ outcome: "started" });
	});
});
