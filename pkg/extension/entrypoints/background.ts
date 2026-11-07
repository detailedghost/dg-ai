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
	registerAgentTabs();
	registerTourState();
	registerProto();
	registerRecording();
	const link = registerDaemonLink();
	registerPairOffer({ adopt: link.adopt });
});
