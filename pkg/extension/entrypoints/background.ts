import {
	registerAgentTabs,
	registerApprovals,
	registerDaemonLink,
	registerProto,
	registerRecording,
	registerTabGrouping,
	registerTourState,
	registerWebMcpScripts,
} from "@/lib/background";
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
	});
});
