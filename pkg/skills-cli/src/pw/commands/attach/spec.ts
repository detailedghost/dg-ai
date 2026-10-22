import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "attach",
	group: "session",
	side: "client",
	positionals: [],
	flags: [
		{ name: "cdp", type: "string", help: "CDP endpoint of a running Chromium browser, e.g. http://127.0.0.1:9222" },
	],
	help: "Attach to a running browser\nConnects over the Chrome DevTools Protocol. Closing the session disconnects and leaves the browser running.",
	changesPage: false,
});
