import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "cookie-list",
	group: "storage",
	side: "daemon",
	positionals: [],
	flags: [
		{ name: "domain", type: "string", help: "filter cookies by domain" },
		{ name: "path", type: "string", help: "filter cookies by path" },
	],
	help: "List all cookies, optionally filtered by domain or path",
	changesPage: false,
});
