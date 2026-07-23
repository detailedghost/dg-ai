import { browser } from "wxt/browser";
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
import {
	onTabComplete,
	tabGroupingSupported,
} from "@/lib/features/tab-grouping";
import { pruneStaleRecordings, removeRecording } from "@/utils/recording-db";

export default defineBackground(() => {
	void pruneStaleRecordings();

	if (tabGroupingSupported()) {
		// Act once navigation settles so tab.url/groupId are final.
		browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
			if (changeInfo.status !== "complete") return;
			void onTabComplete(tabId);
		});
	} else {
		console.warn(
			"[dg-ai-extension] tab grouping API unavailable in this browser — grouping disabled.",
		);
	}

	// Toolbar-icon click is a valid user gesture: start recording if the active
	// tab has a pending video tour (shortcut fallback), else open settings.
	chrome.action.onClicked.addListener((tab) => {
		void (async () => {
			if (videoRecordingSupported() && (await maybeStartRecording(tab))) return;
			void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
		})();
	});

	// Content scripts scope their tour state per-tab; answer "which tab am I?".
	// Also route the video-recording messages (no-ops unless a video tour runs).
	chrome.runtime.onMessage.addListener(
		(
			msg: {
				type?: string;
				target?: string;
				dataUrl?: string;
				durations?: number[];
				index?: number;
			},
			sender,
			sendResponse,
		) => {
			if (msg?.type === MSG.whoami) {
				sendResponse({ tabId: sender.tab?.id ?? null });
				return;
			}
			// requestVideoData needs an async sendResponse — return true to keep the channel open.
			if (msg?.type === MSG.requestVideoData && sender.tab?.id != null) {
				void handleRequestVideoData(sender.tab.id, sendResponse);
				return true;
			}
			if (msg?.type === MSG.videoStop) stopVideoRecording();
			else if (msg?.type === MSG.playStep && typeof msg.index === "number")
				relayPlayStep(msg.index);
			else if (msg?.type === MSG.clearForCapture && msg.target === "background")
				void handleClearForCapture();
			else if (msg?.type === MSG.captureCleared && msg.target === "background")
				chrome.runtime.sendMessage({
					type: MSG.captureCleared,
					target: "offscreen",
				});
			else if (msg?.type === MSG.recordingReady && msg.target === "background")
				void handleRecordingReady(msg.durations ?? []);
			else if (
				msg?.type === MSG.recordingData &&
				msg.target === "background" &&
				typeof msg.dataUrl === "string"
			)
				void handleRecordingData(msg.dataUrl);
			else if (msg?.type === MSG.videoConfirmDownload && sender.tab?.id != null)
				void confirmDownload(sender.tab.id);
			else if (msg?.type === MSG.videoDiscard && sender.tab?.id != null)
				void discardRecording(sender.tab.id);
		},
	);

	// Drop a tab's tour state when it closes, so nothing lingers to hijack later loads.
	chrome.tabs.onRemoved.addListener((tabId) => {
		void chrome.storage.local.remove([
			`demo_tour:${tabId}`,
			`demo_recording:${tabId}`,
			`demo_edit:${tabId}`,
		]);
		void removeRecording(tabId).catch(() => {});
	});

	if (!videoRecordingSupported()) return;

	// Keyboard command is the user gesture that starts recording a video tour —
	// required by Chrome before tabCapture will hand out a stream.
	chrome.commands.onCommand.addListener((command, tab) => {
		if (command === "start-demo-recording") void maybeStartRecording(tab);
	});
});

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
