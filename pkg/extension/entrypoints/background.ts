import {
	registerAgentTabs,
	registerDaemonLink,
	registerPairOffer,
	registerProto,
	registerRecording,
	registerTabGrouping,
	registerTourState,
} from "@/lib/background";
import { pruneStaleRecordings } from "@/utils/recording-db";

export default defineBackground(() => {
	void pruneStaleRecordings();
	registerTabGrouping();
	registerTourState();
	registerProto();
	registerRecording();
	const link = registerDaemonLink();
	registerAgentTabs({
		busy: ({ sessionId }) => link.pending(sessionId).length > 0,
	});
	registerPairOffer({ adopt: link.adopt });
});
