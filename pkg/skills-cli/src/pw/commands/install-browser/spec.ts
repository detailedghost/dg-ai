import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "install-browser",
	group: "core",
	side: "client",
	positionals: [],
	flags: [],
	help: "Download Chromium for pw (about 150 MB)\nRun it only when no Chrome or Edge is installed.",
	changesPage: false,
});
