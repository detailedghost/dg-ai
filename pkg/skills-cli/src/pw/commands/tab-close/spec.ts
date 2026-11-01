import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tab-close",
	group: "tabs",
	side: "daemon",
	positionals: [{ name: "index", required: false }],
	flags: [],
	help: "Close a browser tab\nWithout an index the current tab closes and the previous one is selected.",
	changesPage: true,
});
