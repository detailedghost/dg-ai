import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "network-state-set",
	group: "network",
	side: "daemon",
	positionals: [{ name: "state", required: true }],
	flags: [],
	help: 'Set the browser network state to "online" or "offline"',
	changesPage: false,
});
