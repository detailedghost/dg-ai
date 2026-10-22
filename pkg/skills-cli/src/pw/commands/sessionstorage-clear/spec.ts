import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "sessionstorage-clear",
	group: "storage",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Clear all sessionStorage",
	changesPage: false,
});
