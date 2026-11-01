import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "mousewheel",
	group: "mouse",
	side: "daemon",
	positionals: [
		{ name: "dx", required: true },
		{ name: "dy", required: true },
	],
	flags: [],
	help: "Scroll the mouse wheel",
	changesPage: true,
});
