import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "localstorage-set",
	group: "storage",
	side: "daemon",
	positionals: [
		{ name: "key", required: true },
		{ name: "value", required: true },
	],
	flags: [],
	help: "Set a localStorage item",
	changesPage: false,
});
