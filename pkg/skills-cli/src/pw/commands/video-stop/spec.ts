import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "video-stop",
	group: "devtools",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Stop video recording and save the video",
	changesPage: false,
});
