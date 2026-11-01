import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "state-load",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "filename", required: true }],
	flags: [],
	help: "Load browser storage (authentication) state from a file\nCookies and localStorage are restored. IndexedDB is not restored into a running persistent session.",
	changesPage: true,
});
