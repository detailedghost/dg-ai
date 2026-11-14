import { startOutlookPlugin } from "@/lib/features/webmcp-outlook/plugin";

/** The Outlook built-in Web MCP plugin; the background registers it with the built-in's matches only while it is enabled. */
export default defineContentScript({
	registration: "runtime",
	exclude: ["firefox"],
	runAt: "document_start",
	world: "MAIN",
	main() {
		startOutlookPlugin(window);
	},
});
