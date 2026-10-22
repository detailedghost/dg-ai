import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "go-back",
	group: "navigation",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Go back to the previous page",
	changesPage: true,
});
