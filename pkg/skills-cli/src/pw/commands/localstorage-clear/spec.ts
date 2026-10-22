import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "localstorage-clear",
	group: "storage",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Clear all localStorage",
	changesPage: false,
});
