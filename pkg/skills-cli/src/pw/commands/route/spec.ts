import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "route",
	group: "network",
	side: "daemon",
	positionals: [{ name: "pattern", required: true }],
	flags: [
		{ name: "status", type: "string", help: "http status code (default: 200)" },
		{ name: "body", type: "string", help: "response body (text or json string)" },
		{ name: "content-type", type: "string", help: "content-type header of the mocked response" },
		{ name: "header", type: "string", help: 'header to add in "name: value" format', multiple: true },
		{ name: "remove-header", type: "string", help: "comma separated request header names to remove" },
	],
	help: 'Mock network requests matching a URL pattern, such as "**/api/users"\nWith --status or --body the request is answered by the mock. Otherwise it continues with the header changes.',
	changesPage: false,
});
