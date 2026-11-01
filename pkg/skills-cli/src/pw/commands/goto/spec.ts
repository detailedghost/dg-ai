import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "goto",
	group: "core",
	side: "daemon",
	positionals: [{ name: "url", required: true }],
	flags: [],
	help: "Navigate to a URL",
	changesPage: true,
});
