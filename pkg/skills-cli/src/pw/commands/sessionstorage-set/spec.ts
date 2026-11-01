import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "sessionstorage-set",
	group: "storage",
	side: "daemon",
	positionals: [
		{ name: "key", required: true },
		{ name: "value", required: true },
	],
	flags: [],
	help: "Set a sessionStorage item",
	changesPage: false,
});
