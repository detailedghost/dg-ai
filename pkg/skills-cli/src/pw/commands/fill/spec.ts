import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "fill",
	group: "core",
	side: "daemon",
	positionals: [
		{ name: "target", required: true },
		{ name: "text", required: true },
	],
	flags: [
		{ name: "submit", type: "boolean", help: "press Enter after filling" },
	],
	help: "Fill text into an editable element",
	changesPage: true,
});
