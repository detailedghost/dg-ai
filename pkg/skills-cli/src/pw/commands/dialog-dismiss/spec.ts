import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "dialog-dismiss",
	group: "core",
	side: "daemon",
	positionals: [],
	flags: [],
	help: "Dismiss a dialog",
	changesPage: true,
});
