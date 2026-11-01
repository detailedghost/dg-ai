import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "reload",
	group: "navigation",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Reload the current page",
	changesPage: true,
});
