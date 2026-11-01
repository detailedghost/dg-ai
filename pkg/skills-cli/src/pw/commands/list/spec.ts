import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "list",
	group: "session",
	side: "client",
	positionals: [],
	flags: [],
	help: "List browser sessions",
	changesPage: false,
});
