import { defineCommand } from "../core/spec";

export default defineCommand({
	name: "run-code",
	group: "devtools",
	side: "daemon",
	positionals: [{ name: "code", required: false }],
	flags: [
		{
			name: "filename",
			type: "string",
			help: "load the code from this file (relative paths resolve against the current directory)",
		},
	],
	help: "Run a Playwright code snippet (needs approval each time)\nPass a function such as: async (page) => { await page.goto('https://example.com'); return page.title(); }",
	changesPage: true,
});
