import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "localstorage-get",
	group: "storage",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Get a localStorage item by key",
	changesPage: false,
});
