import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "dialog-accept",
	group: "core",
	side: "daemon",
	positionals: [{ name: "prompt", required: false }],
	flags: [],
	help: "Accept a dialog",
	changesPage: true,
});
