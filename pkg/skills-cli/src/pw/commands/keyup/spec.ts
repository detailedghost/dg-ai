import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "keyup",
	group: "keyboard",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Press a key up on the keyboard",
	changesPage: true,
});
