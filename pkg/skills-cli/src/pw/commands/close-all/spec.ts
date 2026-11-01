import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "close-all",
	group: "session",
	side: "client",
	positionals: [],
	flags: [],
	help: "Close all browser sessions",
	changesPage: false,
});
