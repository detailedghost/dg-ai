import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "keydown",
	group: "keyboard",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Press a key down on the keyboard",
	changesPage: true,
});
