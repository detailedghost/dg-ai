import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "localstorage-delete",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Delete a localStorage item",
	changesPage: false,
});
