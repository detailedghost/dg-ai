import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "kill-all",
	group: "session",
	side: "client",
	positionals: [],
	flags: [],
	help: "Forcefully kill all browser sessions (for stale or zombie processes)",
	changesPage: false,
});
