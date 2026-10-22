import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "click",
	group: "core",
	side: "daemon",
	positionals: [
		{ name: "target", required: true },
		{ name: "button", required: false },
	],
	flags: [
		{
			name: "modifiers",
			type: "string",
			help: "modifier keys to hold, comma separated: Alt, Control, ControlOrMeta, Meta, Shift",
		},
	],
	help: "Perform a click on a web page",
	changesPage: true,
});
