import { browser } from "wxt/browser";
import {
	type DialogShimApi,
	registerAgentTabs,
	registerApprovals,
	registerDaemonLink,
	registerProto,
	registerRecording,
	registerTabGrouping,
	registerTourState,
	registerWebMcpScripts,
	syncDialogShim,
} from "@/lib/background";
import type { AgentTabsStorage } from "@/lib/background/agent-tabs";
import { pruneStaleRecordings } from "@/utils/recording-db";

export default defineBackground(() => {
	void pruneStaleRecordings();
	registerTabGrouping();
	registerTourState();
	registerProto();
	registerRecording();
	registerApprovals();
	registerWebMcpScripts();
	const link = registerDaemonLink();
	registerAgentTabs({
		busy: ({ sessionId }) => link.pending(sessionId).length > 0,
		onAdopted: (tabId) =>
			void syncDialogShim({
				browserApi: browser as unknown as DialogShimApi,
				storage: browser.storage as unknown as AgentTabsStorage,
				tabId,
				regrouped: true,
			}).catch(() => undefined),
	});
});
