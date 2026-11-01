import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tab-select",
	group: "tabs",
	side: "daemon",
	positionals: [{ name: "index", required: true }],
	flags: [],
	help: "Select a browser tab",
	changesPage: true,
});
