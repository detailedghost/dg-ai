import { tourHasAutomaticActions } from "@dg/common";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import {
	confirmDownload,
	discardRecording,
	handleClearForCapture,
	handleNarrationProgress,
	handleRecordingData,
	handleRecordingReady,
	handleRequestVideoData,
	relayCaptureCleared,
	relayPlayStep,
	startVideoRecording,
	stopVideoRecording,
	videoRecordingSupported,
} from "@/lib/features/demo-recorder";

type RecordingMessage = {
	type?: string;
	target?: string;
	dataUrl?: string;
	durations?: number[];
	index?: number;
	progress?: number;
	label?: string;
};

type RecordingSender = chrome.runtime.MessageSender;

type RouteHandler = (msg: RecordingMessage, sender: RecordingSender) => void;

/** Replies the router can send back over an open message channel. */
type RecordingResponse =
	| { dataUrl: string | null }
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
	handleNarrationProgress: typeof handleNarrationProgress;
	handleRecordingData: typeof handleRecordingData;
	confirmDownload: typeof confirmDownload;
	discardRecording: typeof discardRecording;
	handleRequestVideoData: typeof handleRequestVideoData;
	relayCaptureCleared: typeof relayCaptureCleared;
};

const defaultDeps: RecordingDeps = {
	stopVideoRecording,
	relayPlayStep,
	relayCaptureCleared,
	handleClearForCapture,
	handleRecordingReady,
	handleNarrationProgress,
	handleRecordingData,
	confirmDownload,
	discardRecording,
	handleRequestVideoData,
};

function buildRoutes(deps: RecordingDeps): Record<string, RouteHandler> {
	return {
		[MSG.videoStop]: () => void deps.stopVideoRecording(),
		[MSG.playStep]: (msg) => {
			if (typeof msg.index === "number") void deps.relayPlayStep(msg.index);
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
		[MSG.recordingData]: (msg) => {
			if (msg.target === "background" && typeof msg.dataUrl === "string")
				void deps.handleRecordingData(msg.dataUrl);
		},
		[MSG.videoConfirmDownload]: (_msg, sender) => {
			if (sender.tab?.id != null) void deps.confirmDownload(sender.tab.id);
		},
		[MSG.videoDiscard]: (_msg, sender) => {
			if (sender.tab?.id != null) void deps.discardRecording(sender.tab.id);
		},
	};
}

/**
 * Build a recording-message router bound to `deps` (real demo-recorder functions
 * in production, injected mocks in tests). requestVideoData and requestRecordShortcut
 * are special-cased — they reply asynchronously, so the caller must keep the message
 * channel open (return true from the onMessage listener) when the handler returns true.
 */
export function createRecordingRouter(
	deps: RecordingDeps,
): (
	msg: RecordingMessage,
	sender: RecordingSender,
	sendResponse: (data: RecordingResponse) => void,
) => boolean | void {
	const routes = buildRoutes(deps);
	return (msg, sender, sendResponse) => {
		if (msg?.type === MSG.requestVideoData && sender.tab?.id != null) {
			void deps.handleRequestVideoData(sender.tab.id, sendResponse);
			return true;
		}
		if (msg?.type === MSG.requestRecordShortcut) {
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

/** Wire the recording gestures (toolbar click, keyboard command) and message router. */
export function registerRecording(): void {
	// Toolbar-icon click is a valid user gesture: start recording if the active
	// tab has a pending video tour (shortcut fallback), else open settings.
	chrome.action.onClicked.addListener((tab) => {
		void (async () => {
			if (videoRecordingSupported() && (await maybeStartRecording(tab))) return;
			void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
		})();
	});

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
