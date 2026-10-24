import { runDemoTour } from "@/lib/features/demo-tour";
import {
	detectPageNotReady,
	PROTO_NOT_READY,
	PROTO_PROGRESS,
	PROTO_SAVE_STYLE_GUIDE,
	plantPrototype,
	scrapeStyleGuide,
} from "@/lib/features/prototype";
import {
	PROTO_MARKER_KEY,
	readProtoPayload,
	stripProtoMarker,
} from "@/utils/proto-marker";

type ContentContext = Parameters<typeof runDemoTour>[0];

function hasProtoMarker(url: string): boolean {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) return false;
	return url
		.slice(hashIndex + 1)
		.split("&")
		.some((entry) => entry.split("=", 1)[0] === PROTO_MARKER_KEY);
}

/**
 * Handle prototype markers before demo state initialization. Any `_proto`
 * marker—valid or malformed—owns this page load and prevents demo storage
 * reads/writes; plant dispatch is completed by the picker slice. A not-ready
 * page (login wall, HTTP error, redirect) reports immediately instead of
 * scraping or planting against the wrong page.
 */
export async function runProto(_ctx: ContentContext): Promise<boolean> {
	const url = location.href;
	if (!hasProtoMarker(url)) return false;
	const payload = await readProtoPayload(url);
	history.replaceState(history.state, "", stripProtoMarker(url));
	if (!payload) return true;

	const notReady = detectPageNotReady(payload.expectedUrl);
	if (notReady) {
		await chrome.runtime.sendMessage({ type: PROTO_NOT_READY, error: notReady });
		return true;
	}
	await chrome.runtime.sendMessage({
		type: PROTO_PROGRESS,
		status:
			payload.phase === "scrape"
				? "ready; scraping the style guide"
				: "ready; planting the comparison",
	});

	if (payload.phase === "scrape") {
		const styleGuide = scrapeStyleGuide();
		await chrome.runtime.sendMessage({
			type: PROTO_SAVE_STYLE_GUIDE,
			styleGuide,
		});
	} else {
		await plantPrototype(payload.plan);
	}
	return true;
}

// Matches everything so any app can be demoed, but stays fully inert unless the
// page carries a `_demo` marker or a tour is already in progress (see runDemoTour).
export default defineContentScript({
	matches: ["<all_urls>"],
	runAt: "document_idle",
	cssInjectionMode: "ui",
	async main(ctx) {
		if (await runProto(ctx)) return;
		await runDemoTour(ctx);
	},
});
