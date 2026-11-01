import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tracing-start",
	group: "devtools",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Start trace recording",
	changesPage: false,
});
