import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "mousemove",
	group: "mouse",
	side: "daemon",
	positionals: [
		{ name: "x", required: true },
		{ name: "y", required: true },
	],
	flags: [],
	help: "Move the mouse to a given position",
	changesPage: true,
});
