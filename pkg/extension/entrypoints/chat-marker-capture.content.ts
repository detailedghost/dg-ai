import { MSG } from "@/lib/chat-messages";
import { readChatBootstrap, stripChatMarker } from "@/utils/chat-marker";

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
