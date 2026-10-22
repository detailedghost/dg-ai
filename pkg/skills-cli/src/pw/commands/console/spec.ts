import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "console",
	group: "devtools",
	side: "daemon",
	positionals: [{ name: "min-level", required: false }],
	flags: [{ name: "clear", type: "boolean", help: "clear the console list after listing it" }],
	help: "List console messages\nmin-level is error, warning, info, or debug. Each level includes the more severe ones. The default is info.",
	changesPage: false,
});
