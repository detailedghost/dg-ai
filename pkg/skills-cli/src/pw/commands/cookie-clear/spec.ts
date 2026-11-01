import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "cookie-clear",
	group: "storage",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Clear all cookies",
	changesPage: false,
});
