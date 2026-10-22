import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "open",
	group: "session",
	side: "client",
	positionals: [{ name: "url", required: false }],
	flags: [
		{ name: "scratch", type: "boolean", help: "use an ephemeral profile, keyed to this directory" },
		{ name: "headless", type: "boolean", help: "run without a visible window" },
		{ name: "windows", type: "boolean", help: "open Windows Chrome or Edge over CDP (WSL only; not with --scratch)" },
		{ name: "browser", type: "string", help: "browser or channel: chrome, chromium, msedge, firefox, webkit" },
		{
			name: "profile",
			type: "string",
			help: "persistent profile directory (default: ~/.cache/playwright-cli/profiles/<session>)",
		},
		{ name: "from", type: "string", help: "seed the session from a saved state (see: pw state list)" },
		{ name: "out", type: "string", help: "output directory for snapshots and files (default: /tmp/ai/pw/<cwd-hash>)" },
		{ name: "persistent", type: "boolean", help: "accepted for compatibility; persistent profiles are the default" },
		{ name: "depth", type: "string", help: "default snapshot depth for this session (0 means unlimited; default: 6)" },
	],
	help: "Open the browser\nOpens a persistent profile unless --scratch is set.",
	changesPage: false,
});
