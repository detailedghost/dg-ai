import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "mouseup",
	group: "mouse",
	side: "daemon",
	positionals: [{ name: "button", required: false }],
	flags: [],
	help: "Release the mouse button",
	changesPage: true,
});
