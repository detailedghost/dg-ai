import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "close",
	group: "core",
	side: "client",
	positionals: [],
	flags: [],
	help: "Close the browser",
	changesPage: false,
});
