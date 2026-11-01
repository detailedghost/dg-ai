import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "snapshot",
	group: "core",
	side: "daemon",
	positionals: [{ name: "element", required: false }],
	flags: [
		{
			name: "filename",
			type: "string",
			help: "save the snapshot to this file (relative paths resolve against the output directory)",
		},
		{
			name: "depth",
			type: "string",
			help: "limit snapshot depth (default: 6; 0 means unlimited)",
		},
		{ name: "full", type: "boolean", help: "capture the full depth" },
	],
	help: "Capture a page snapshot to obtain element refs\nPass a ref or selector to snapshot one subtree.",
	changesPage: false,
});
