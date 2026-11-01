import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "cookie-set",
	group: "storage",
	side: "daemon",
	positionals: [
		{ name: "name", required: true },
		{ name: "value", required: true },
	],
	flags: [
		{
			name: "domain",
			type: "string",
			help: "cookie domain (default: the current page host)",
		},
		{ name: "path", type: "string", help: "cookie path (default: /)" },
		{
			name: "expires",
			type: "string",
			help: "expiration as a unix timestamp in seconds",
		},
		{ name: "httpOnly", type: "boolean", help: "mark the cookie HTTP only" },
		{ name: "secure", type: "boolean", help: "mark the cookie secure" },
		{
			name: "sameSite",
			type: "string",
			help: "SameSite attribute: Strict, Lax, or None",
		},
	],
	help: "Set a cookie with optional flags",
	changesPage: false,
});
