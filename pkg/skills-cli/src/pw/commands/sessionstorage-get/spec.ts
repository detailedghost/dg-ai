import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "sessionstorage-get",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Get a sessionStorage item by key",
	changesPage: false,
});
