import { browser } from "wxt/browser";
import {
	MAILBOX_CLI_CONNECT_TYPE,
	parseMailboxCliMarker,
	stripMailboxCliMarker,
} from "@/lib/features/mailbox-cleanup/cli-transport";

export default defineContentScript({
	matches: ["http://127.0.0.1/*"],
	runAt: "document_start",
	async main() {
		let connection;
		try {
			connection = parseMailboxCliMarker(location.href);
		} catch {
			return;
		}
		if (connection === undefined) return;
		history.replaceState(
			history.state,
			"",
			stripMailboxCliMarker(location.href),
		);
		await browser.runtime.sendMessage({
			type: MAILBOX_CLI_CONNECT_TYPE,
			connection,
		});
	},
});

