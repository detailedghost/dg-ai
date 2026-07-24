import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import {
	confirmDownload,
	discardRecording,
	handleClearForCapture,
	handleRecordingData,
	handleRecordingReady,
	handleRequestVideoData,
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
};

type RecordingSender = chrome.runtime.MessageSender;

type RouteHandler = (msg: RecordingMessage, sender: RecordingSender) => void;

/** The demo-recorder functions the router dispatches to — injectable for tests. */
export type RecordingDeps = {
	stopVideoRecording: typeof stopVideoRecording;
	relayPlayStep: typeof relayPlayStep;
	handleClearForCapture: typeof handleClearForCapture;
	handleRecordingReady: typeof handleRecordingReady;
	handleRecordingData: typeof handleRecordingData;
	confirmDownload: typeof confirmDownload;
	discardRecording: typeof discardRecording;
	handleRequestVideoData: typeof handleRequestVideoData;
};

const defaultDeps: RecordingDeps = {
	stopVideoRecording,
	relayPlayStep,
	handleClearForCapture,
	handleRecordingReady,
	handleRecordingData,
	confirmDownload,
	discardRecording,
	handleRequestVideoData,
};

function buildRoutes(deps: RecordingDeps): Record<string, RouteHandler> {
	return {
		[MSG.videoStop]: () => deps.stopVideoRecording(),
		[MSG.playStep]: (msg) => {
			if (typeof msg.index === "number") deps.relayPlayStep(msg.index);
		},
		[MSG.clearForCapture]: (msg) => {
			if (msg.target === "background") void deps.handleClearForCapture();
		},
		[MSG.captureCleared]: (msg) => {
			if (msg.target === "background")
				chrome.runtime.sendMessage({
					type: MSG.captureCleared,
					target: "offscreen",
				});
		},
		[MSG.recordingReady]: (msg) => {
			if (msg.target === "background")
				void deps.handleRecordingReady(msg.durations ?? []);
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
 * in production, injected mocks in tests). requestVideoData is special-cased — it
 * replies asynchronously, so the caller must keep the message channel open (return
 * true from the onMessage listener) when the returned handler returns true.
 */
export function createRecordingRouter(
	deps: RecordingDeps,
): (
	msg: RecordingMessage,
	sender: RecordingSender,
	sendResponse: (data: { dataUrl: string | null }) => void,
) => boolean | void {
	const routes = buildRoutes(deps);
	return (msg, sender, sendResponse) => {
		if (msg?.type === MSG.requestVideoData && sender.tab?.id != null) {
			void deps.handleRequestVideoData(sender.tab.id, sendResponse);
			return true;
		}
		routes[msg?.type ?? ""]?.(msg, sender);
	};
}

export const handleRecordingMessage = createRecordingRouter(defaultDeps);

/** Start recording iff the active tab runs a video tour; returns whether it did. */
async function maybeStartRecording(tab?: chrome.tabs.Tab): Promise<boolean> {
	if (!tab?.id) return false;
	const key = `demo_tour:${tab.id}`;
	const stored = (await chrome.storage.local.get(key)) as Record<
		string,
		{ script?: TourScript } | undefined
	>;
	const script = stored[key]?.script;
	if (script?.mode !== "video") return false;
	try {
		await startVideoRecording(tab.id, script);
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
		if (command === "start-demo-recording") void maybeStartRecording(tab);
	});
}
