import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "state",
	group: "state",
	side: "client",
	positionals: [
		{ name: "subcommand", required: true },
		{ name: "arguments", required: false, variadic: true },
	],
	flags: [],
	help: [
		"Named saved sessions (cookies, localStorage, IndexedDB)",
		"  pw state save <name>           save this session's state",
		"  pw state load <name>           load a saved state into this session",
		"  pw state list                  list saved states",
		"  pw state delete <name>         delete a saved state",
		"  pw state import <file> [name]  import a storage state file",
		"Seed a new session with: pw open --from=<name>",
	].join("\n"),
	changesPage: false,
});
