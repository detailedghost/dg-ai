import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "resize",
	group: "core",
	side: "daemon",
	positionals: [
		{ name: "w", required: true },
		{ name: "h", required: true },
	],
	flags: [],
	help: "Resize the browser window",
	changesPage: true,
});
