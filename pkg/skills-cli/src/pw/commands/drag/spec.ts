import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "drag",
	group: "core",
	side: "daemon",
	positionals: [
		{ name: "startElement", required: true },
		{ name: "endElement", required: true },
	],
	flags: [],
	help: "Perform drag and drop between two elements",
	changesPage: true,
});
