import { browser } from "wxt/browser";
import {
	onTabComplete,
	tabGroupingSupported,
} from "@/lib/features/tab-grouping";

export default defineBackground(() => {
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
});
