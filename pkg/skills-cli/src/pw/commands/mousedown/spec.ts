import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "mousedown",
	group: "mouse",
	side: "daemon",
	positionals: [{ name: "button", required: false }],
	flags: [],
	help: "Press the mouse button down",
	changesPage: true,
});
