import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "delete-data",
	group: "session",
	side: "client",
	positionals: [],
	flags: [],
	help: "Close the session and delete its saved profile data\nOnly profiles under ~/.cache/playwright-cli/profiles are deleted.",
	changesPage: false,
});
