import { browser } from "wxt/browser";
import {
	createMailboxCleanupBackgroundComposition,
	registerProto,
	registerRecording,
	registerTabGrouping,
	registerTourState,
	type MailboxCleanupBrowserSeam,
} from "@/lib/background";
import { bundledMailboxProviders } from "@/lib/features/mailbox-cleanup/providers/bundled";
import { pruneStaleRecordings } from "@/utils/recording-db";

export default defineBackground(() => {
	void pruneStaleRecordings();
	const mailbox = createMailboxCleanupBackgroundComposition({
		browser: browser as unknown as MailboxCleanupBrowserSeam,
		indexedDB,
		providers: bundledMailboxProviders,
	});
	mailbox.register();
	registerTabGrouping();
	registerTourState();
	registerProto();
	registerRecording();
});
