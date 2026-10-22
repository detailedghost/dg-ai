import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "state-save",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "filename", required: false }],
	flags: [],
	help: "Save the current storage (authentication) state to a file\nThe file is written with mode 0600. The default is storage-state-<timestamp>.json in the output directory.",
	changesPage: false,
});
