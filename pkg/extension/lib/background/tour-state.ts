import { MSG } from "@/lib/demo-messages";
import { removeRecording } from "@/utils/recording-db";

/** Answer "which tab am I?" and drop a tab's tour state when it closes. */
export function registerTourState(): void {
	// Content scripts scope their tour state per-tab; answer "which tab am I?".
	chrome.runtime.onMessage.addListener(
		(msg: { type?: string }, sender, sendResponse) => {
			if (msg?.type !== MSG.whoami) return;
			sendResponse({ tabId: sender.tab?.id ?? null });
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
}
