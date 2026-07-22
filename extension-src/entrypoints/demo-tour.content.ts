import { runDemoTour } from "@/lib/features/demo-tour";

// Matches everything so any app can be demoed, but stays fully inert unless the
// page carries a `_demo` marker or a tour is already in progress (see runDemoTour).
export default defineContentScript({
	matches: ["<all_urls>"],
	runAt: "document_idle",
	cssInjectionMode: "ui",
	async main(ctx) {
		await runDemoTour(ctx);
	},
});
