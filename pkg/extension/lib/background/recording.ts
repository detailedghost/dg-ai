import { tourHasAutomaticActions } from "@dg/common";
import { type DownloadResult, MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import {
	activeRecordingRefusal,
	confirmDownload,
	discardRecording,
	handleClearForCapture,
	handleNarrationComplete,
	handleNarrationProgress,
	handleRecordingReady,
	handleRecordingSaved,
	relayCaptureCleared,
	relayPlayStep,
	startVideoRecording,
	stopVideoRecording,
	videoRecordingSupported,
	warmNarration,
} from "@/lib/features/demo-recorder";

type RecordingMessage = {
	type?: string;
	target?: string;
	saved?: boolean;
	error?: string;
	/** The *recording's* tab, named explicitly because review messages come from another one. */
	tabId?: number;
	durations?: number[];
	index?: number;
	progress?: number;
	label?: string;
};

type RecordingSender = chrome.runtime.MessageSender;

type RouteHandler = (msg: RecordingMessage, sender: RecordingSender) => void;

/** Replies the router can send back over an open message channel. */
type RecordingResponse =
	| DownloadResult
	| { ok: boolean }
	| { shortcut: string | null };

/** The manifest command whose keypress starts a recording. */
export const RECORD_COMMAND = "start-demo-recording";

/**
 * The shortcut Chrome actually bound to the record command, or null if it bound none.
 *
 * `suggested_key` is only a request: when another extension already holds the combo —
 * a stale unpacked copy of this same extension is the easy way to cause that — Chrome
 * silently leaves ours unassigned. The page must be told that, because the keypress
 * then reaches a different extension entirely and nothing here ever runs.
 */
export function assignedRecordShortcut(
	commands: chrome.commands.Command[],
): string | null {
	const found = commands.find((c) => c.name === RECORD_COMMAND)?.shortcut;
	return found ? found : null;
}

/** Persisted lifecycle fields used to decide whether video capture may start. */
export type RecordingTourState = {
	script?: TourScript;
	phase?: "setup" | "tutorial";
	setupActionsApproved?: boolean;
	automaticActionsApproved?: boolean;
};

/**
 * Why capture may not start from the persisted tour state, or null when it may.
 *
 * A reason rather than a bare boolean because the record gesture is the one
 * moment the user has been told to press a key: declining in silence reads as a
 * broken extension.
 */
export function recordingRefusal(
	state: RecordingTourState | undefined,
): string | null {
	const script = state?.script;
	if (script?.mode !== "video") return "This tab isn't running a video tour.";
	if (state?.phase !== "tutorial")
		return "Finish the setup steps first — recording starts once the tour reaches step 1.";
	if (!tourHasAutomaticActions(script)) return null;
	if (state?.automaticActionsApproved === true) return null;
	return !script.steps.some((step) => step.action != null) &&
		state?.setupActionsApproved === true
		? null
		: "Approve this tour's automatic actions before recording.";
}

/** The demo-recorder functions the router dispatches to — injectable for tests. */
export type RecordingDeps = {
	stopVideoRecording: typeof stopVideoRecording;
	relayPlayStep: typeof relayPlayStep;
	handleClearForCapture: typeof handleClearForCapture;
	handleRecordingReady: typeof handleRecordingReady;
	handleNarrationComplete: typeof handleNarrationComplete;
	handleNarrationProgress: typeof handleNarrationProgress;
	handleRecordingSaved: typeof handleRecordingSaved;
	confirmDownload: typeof confirmDownload;
	discardRecording: typeof discardRecording;
	relayCaptureCleared: typeof relayCaptureCleared;
	warmNarration: typeof warmNarration;
};

const defaultDeps: RecordingDeps = {
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
};

function buildRoutes(deps: RecordingDeps): Record<string, RouteHandler> {
	return {
		[MSG.videoStop]: (_msg, sender) => {
			if (sender.tab?.id != null) void deps.stopVideoRecording(sender.tab.id);
		},
		[MSG.playStep]: (msg, sender) => {
			if (sender.tab?.id != null && typeof msg.index === "number")
				void deps.relayPlayStep(sender.tab.id, msg.index);
		},
		[MSG.clearForCapture]: (msg) => {
			if (msg.target === "background") void deps.handleClearForCapture();
		},
		[MSG.captureCleared]: (msg) => {
			if (msg.target === "background") void deps.relayCaptureCleared();
		},
		[MSG.recordingReady]: (msg) => {
			if (msg.target === "background")
				void deps.handleRecordingReady(msg.durations ?? []);
		},
		[MSG.narrationProgress]: (msg) => {
			if (
				msg.target === "background" &&
				typeof msg.progress === "number" &&
				Number.isFinite(msg.progress)
			)
				void deps.handleNarrationProgress(msg.progress, msg.label);
		},
		[MSG.narrationComplete]: (msg) => {
			if (msg.target === "background" && typeof msg.index === "number")
				void deps.handleNarrationComplete(msg.index);
		},
		[MSG.recordingSaved]: (msg) => {
			if (msg.target === "background" && typeof msg.saved === "boolean")
				void deps.handleRecordingSaved(msg.saved, msg.error);
		},
	};
}

/**
 * Build a recording-message router bound to `deps` (real demo-recorder functions
 * in production, injected mocks in tests). The review-page buttons and
 * requestRecordShortcut are special-cased — they reply asynchronously, so the caller
 * must keep the message channel open (return true from the onMessage listener) when
 * the handler returns true.
 *
 * The review routes take their tab id from the *payload*, never from `sender`: the
 * sender is the review tab, and the recording is keyed by the tab that was recorded.
 * Reading `sender.tab.id` here would look right and silently act on nothing.
 */
export function createRecordingRouter(
	deps: RecordingDeps,
): (
	msg: RecordingMessage,
	sender: RecordingSender,
	sendResponse: (data: RecordingResponse) => void,
) => boolean | undefined {
	const routes = buildRoutes(deps);
	return (msg, sender, sendResponse) => {
		if (
			msg?.type === MSG.videoConfirmDownload &&
			typeof msg.tabId === "number"
		) {
			void deps
				.confirmDownload(msg.tabId)
				.then(sendResponse)
				.catch((err: unknown) =>
					sendResponse({ ok: false, error: String(err) }),
				);
			return true;
		}
		if (msg?.type === MSG.videoDiscard && typeof msg.tabId === "number") {
			void deps
				.discardRecording(msg.tabId)
				.then(sendResponse)
				.catch(() => sendResponse({ ok: false }));
			return true;
		}
		if (msg?.type === MSG.requestRecordShortcut) {
			// Asking for the shortcut means a tour is about to display "press this to
			// record" — the earliest honest signal that narration will be needed soon.
			void deps.warmNarration().catch(() => {});
			void chrome.commands
				.getAll()
				.then((cmds) =>
					sendResponse({ shortcut: assignedRecordShortcut(cmds) }),
				)
				.catch(() => sendResponse({ shortcut: null }));
			return true;
		}
		routes[msg?.type ?? ""]?.(msg, sender);
	};
}

export const handleRecordingMessage = createRecordingRouter(defaultDeps);

/** Start recording iff the active tab runs a video tour; returns whether it did. */
export async function maybeStartRecording(
	tab?: chrome.tabs.Tab,
	startRecording: typeof startVideoRecording = startVideoRecording,
): Promise<boolean> {
	if (!tab?.id) return false;
	// Every call site must skip video capture where tabCapture/offscreen don't exist,
	// same invariant registerRecording's own command listener guards separately.
	if (!videoRecordingSupported()) return false;
	const key = `demo_tour:${tab.id}`;
	const stored = (await chrome.storage.local.get(key)) as Record<
		string,
		RecordingTourState | undefined
	>;
	const state = stored[key];
	const script = state?.script;
	if (script?.mode !== "video") return false;
	// Declining is still "handled" — but say so on the page, or the keypress the user
	// was told to press does nothing at all.
	const refusal = recordingRefusal(state);
	if (refusal) {
		void chrome.tabs.sendMessage(tab.id, {
			type: MSG.videoBlocked,
			reason: refusal,
		});
		return true;
	}
	// One offscreen doc captures one tab; must be decided before startRecording
	// ever calls acquireStreamId — see that function's doc comment for why.
	const activeConflict = await activeRecordingRefusal(tab.id);
	if (activeConflict) {
		void chrome.tabs.sendMessage(tab.id, {
			type: MSG.videoBlocked,
			reason: activeConflict,
		});
		return true;
	}
	try {
		await startRecording(tab.id, script);
	} catch (err) {
		// Surface the failure in the page instead of failing silently.
		const error = err instanceof Error ? err.message : String(err);
		void chrome.tabs.sendMessage(tab.id, { type: MSG.videoError, error });
		console.error("[dg-ai-extension] start recording failed:", err);
	}
	return true;
}

/** Wire the recording message router and (Chrome/Edge only) keyboard command. */
export function registerRecording(): void {
	// Toolbar-icon click is owned by registerChat now — it starts a pending
	// recording first and opens chat otherwise, so it lives in exactly one place.
	chrome.runtime.onMessage.addListener(
		(msg: RecordingMessage, sender, sendResponse) =>
			handleRecordingMessage(msg, sender, sendResponse),
	);

	if (!videoRecordingSupported()) return;

	// Keyboard command is the user gesture that starts recording a video tour —
	// required by Chrome before tabCapture will hand out a stream.
	chrome.commands.onCommand.addListener((command, tab) => {
		if (command === RECORD_COMMAND) void maybeStartRecording(tab);
	});
}
