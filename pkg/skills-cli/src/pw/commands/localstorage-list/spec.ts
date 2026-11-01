import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "localstorage-list",
	group: "storage",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "List all localStorage key-value pairs",
	changesPage: false,
});
