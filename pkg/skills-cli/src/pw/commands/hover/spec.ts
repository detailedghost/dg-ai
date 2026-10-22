import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "hover",
	group: "core",
	side: "daemon",
	positionals: [{ name: "target", required: true }],
	flags: [],
	help: "Hover over an element on the page",
	changesPage: true,
});
