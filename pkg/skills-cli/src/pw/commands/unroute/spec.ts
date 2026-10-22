import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "unroute",
	group: "network",
	side: "daemon",
	positionals: [{ name: "pattern", required: false }],
	flags: [],
	help: "Remove routes matching a pattern, or all routes without a pattern",
	changesPage: false,
});
