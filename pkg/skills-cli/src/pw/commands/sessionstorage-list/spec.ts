import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "sessionstorage-list",
	group: "storage",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "List all sessionStorage key-value pairs",
	changesPage: false,
});
