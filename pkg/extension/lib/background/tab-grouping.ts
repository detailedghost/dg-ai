import { browser } from "wxt/browser";
import {
	onTabComplete,
	tabGroupingSupported,
} from "@/lib/features/tab-grouping";

/** Wire marker-driven tab grouping, or warn once if the browser lacks the APIs. */
export function registerTabGrouping(): void {
	if (!tabGroupingSupported()) {
		console.warn(
			"[dg-ai-extension] tab grouping API unavailable in this browser — grouping disabled.",
		);
		return;
	}
	// Act once navigation settles so tab.url/groupId are final.
	browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (changeInfo.status !== "complete") return;
		void onTabComplete(tabId);
	});
}
