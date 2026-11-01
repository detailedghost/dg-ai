import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "press",
	group: "keyboard",
	side: "daemon",
	positionals: [{ name: "key", required: true }],
	flags: [],
	help: "Press a key on the keyboard, such as Enter or ArrowLeft",
	changesPage: true,
});
