import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "cookie-get",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "name", required: true }],
	flags: [],
	help: "Get a specific cookie by name",
	changesPage: false,
});
