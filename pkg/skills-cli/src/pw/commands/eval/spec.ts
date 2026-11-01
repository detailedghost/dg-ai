import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "eval",
	group: "core",
	side: "daemon",
	positionals: [
		{ name: "func", required: true },
		{ name: "element", required: false },
	],
	flags: [
		{
			name: "filename",
			type: "string",
			help: "save the result to this file instead of returning it",
		},
	],
	help: "Evaluate a JavaScript expression or function on the page or an element",
	changesPage: false,
});
