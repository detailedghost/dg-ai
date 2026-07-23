import {
	registerRecording,
	registerTabGrouping,
	registerTourState,
} from "@/lib/background";
import { pruneStaleRecordings } from "@/utils/recording-db";

export default defineBackground(() => {
	void pruneStaleRecordings();
	registerTabGrouping();
	registerTourState();
	registerRecording();
});
