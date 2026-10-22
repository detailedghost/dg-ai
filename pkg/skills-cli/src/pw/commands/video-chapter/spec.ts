import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "video-chapter",
	group: "devtools",
	side: "daemon",
	positionals: [{ name: "title", required: true }],
	flags: [
		{ name: "description", type: "string", help: "chapter description" },
		{ name: "duration", type: "string", help: "milliseconds to show the chapter card (default: 2000)" },
	],
	help: "Add a chapter marker to the video recording",
	changesPage: false,
});
