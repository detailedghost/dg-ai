import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "network",
	group: "devtools",
	side: "daemon",
	positionals: [],
	flags: [
		{
			name: "static",
			type: "boolean",
			help: "include successful static resources such as images, fonts, and scripts",
		},
		{ name: "request-body", type: "boolean", help: "include the request body" },
		{
			name: "request-headers",
			type: "boolean",
			help: "include the request headers",
		},
		{
			name: "filter",
			type: "string",
			help: 'only requests whose url matches this regular expression, such as "/api/.*user"',
		},
		{
			name: "clear",
			type: "boolean",
			help: "clear the request list after listing it",
		},
	],
	help: "List network requests since the page loaded\nSuccessful fetch and XHR calls and failed requests are listed. Add --static for the rest.",
	changesPage: false,
});
