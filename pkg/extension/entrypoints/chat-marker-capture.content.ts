import { MSG } from "@dg/pages/chat-messages";
import { readChatBootstrap, stripChatMarker } from "@dg/pages/chat-marker";

const LOCAL_PAGE_PATHS = new Set(["/chat", "/board"]);

export default defineContentScript({
	matches: ["http://127.0.0.1/*"],
	runAt: "document_start",
	async main() {
		const url = location.href;
		if (LOCAL_PAGE_PATHS.has(new URL(url).pathname)) return;
		const stripped = stripChatMarker(url);
		if (stripped === url) return;
		const bootstrap = readChatBootstrap(url);
		if (bootstrap) {
			chrome.runtime.sendMessage({ type: MSG.markerCaptured, bootstrap });
		}
		history.replaceState(history.state, "", stripped);
	},
});
