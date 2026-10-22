import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "screenshot",
	group: "core",
	side: "daemon",
	positionals: [{ name: "target", required: false }],
	flags: [
		{
			name: "filename",
			type: "string",
			help: "file to save to (default: page-<timestamp>.png in the output directory)",
		},
		{ name: "full-page", type: "boolean", help: "capture the full scrollable page" },
		{
			name: "color-scheme",
			type: "string",
			help: "emulate light or dark before capturing, then restore the page's own preference (for before/after demo pairs)",
		},
	],
	help: "Take a screenshot of the page or an element",
	changesPage: false,
});
