import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "check",
	group: "core",
	side: "daemon",
	positionals: [{ name: "target", required: true }],
	flags: [],
	help: "Check a checkbox or radio button",
	changesPage: true,
});
