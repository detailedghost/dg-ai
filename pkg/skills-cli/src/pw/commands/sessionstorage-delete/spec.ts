import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "sessionstorage-delete",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Delete a sessionStorage item",
	changesPage: false,
});
