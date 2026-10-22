import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "video-start",
	group: "devtools",
	side: "daemon",
	positionals: [{ name: "filename", required: false }],
	flags: [{ name: "size", type: "string", help: 'video frame size, such as "800x600" (default: fits 800x800)' }],
	help: "Start video recording of the current tab (needs ffmpeg)",
	changesPage: false,
});
