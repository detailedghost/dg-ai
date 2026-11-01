import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tab-list",
	group: "tabs",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "List all tabs",
	changesPage: false,
});
