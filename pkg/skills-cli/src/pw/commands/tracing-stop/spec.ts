import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tracing-stop",
	group: "devtools",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Stop trace recording and save the trace zip",
	changesPage: false,
});
