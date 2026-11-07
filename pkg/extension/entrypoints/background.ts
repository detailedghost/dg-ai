import {
	registerAgentTabs,
	registerChat,
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
	registerChat();
});
