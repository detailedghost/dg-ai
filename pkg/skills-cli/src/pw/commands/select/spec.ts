import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "select",
	group: "core",
	side: "daemon",
	positionals: [
		{ name: "target", required: true },
		{ name: "val", required: true, variadic: true },
	],
	flags: [],
	help: "Select an option in a dropdown",
	changesPage: true,
});
