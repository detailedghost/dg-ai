import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "pdf",
	group: "core",
	side: "daemon",
	positionals: [],
	flags: [
		{
			name: "filename",
			type: "string",
			help: "file name to save the pdf to (default: page-<timestamp>.pdf in the output directory)",
		},
	],
	help: "Save the page as PDF (Chromium only)",
	changesPage: false,
});
