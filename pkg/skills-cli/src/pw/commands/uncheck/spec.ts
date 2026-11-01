import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "uncheck",
	group: "core",
	side: "daemon",
	positionals: [{ name: "target", required: true }],
	flags: [],
	help: "Uncheck a checkbox",
	changesPage: true,
});
