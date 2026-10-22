import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "route-list",
	group: "network",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "List all active network routes",
	changesPage: false,
});
