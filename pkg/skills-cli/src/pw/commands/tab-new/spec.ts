import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tab-new",
	group: "tabs",
	side: "daemon",
	positionals: [{ name: "url", required: false }],
	flags: [],
	help: "Create a new tab",
	changesPage: true,
});
