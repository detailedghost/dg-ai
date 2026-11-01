import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "cookie-delete",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "name", required: true }],
	flags: [],
	help: "Delete a specific cookie",
	changesPage: false,
});
