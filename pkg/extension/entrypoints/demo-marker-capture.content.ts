import { captureMarkerEarly } from "@/lib/features/demo-tour";

/**
 * Runs at document_start — before the target page's own scripts — so a
 * client-side auth guard that redirects early (dropping the URL fragment) can't
 * discard the tour's `_demo` marker before demo-tour.content.ts gets to read it.
 */
export default defineContentScript({
	matches: ["<all_urls>"],
	runAt: "document_start",
	async main() {
		await captureMarkerEarly();
	},
});
