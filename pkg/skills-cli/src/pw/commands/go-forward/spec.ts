import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "go-forward",
	group: "navigation",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Go forward to the next page",
	changesPage: true,
});
