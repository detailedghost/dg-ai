import { MSG } from "@/lib/chat-messages";
import { readChatBootstrap, stripChatMarker } from "@/utils/chat-marker";

/**
 * Loopback-only: the `_chat` marker only ever appears on the daemon's own
 * bootstrap page, so this script must never run on `<all_urls>` like the demo
 * marker capture does — that would make session tokens parseable on every page.
 */
export default defineContentScript({
	matches: ["http://127.0.0.1/*"],
	runAt: "document_start",
	async main() {
		const url = location.href;
		const stripped = stripChatMarker(url);
		if (stripped === url) return;
		const bootstrap = readChatBootstrap(url);
		if (bootstrap) {
			chrome.runtime.sendMessage({ type: MSG.markerCaptured, bootstrap });
		}
		history.replaceState(history.state, "", stripped);
	},
});
