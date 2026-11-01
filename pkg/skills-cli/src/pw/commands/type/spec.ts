import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "type",
	group: "core",
	side: "daemon",
	positionals: [{ name: "text", required: true }],
	flags: [
		{ name: "submit", type: "boolean", help: "press Enter after typing" },
	],
	help: "Type text into the focused element",
	changesPage: true,
});
