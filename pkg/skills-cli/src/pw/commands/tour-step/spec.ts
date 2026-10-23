import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "tour-step",
	group: "devtools",
	side: "daemon",
	positionals: [{ name: "body", required: true }],
	flags: [
		{ name: "target", type: "string", help: "CSS selector to spotlight; omit for a centered card" },
		{ name: "heading", type: "string", help: "step heading shown above the body" },
		{ name: "script-title", type: "string", help: "tour title shown in the progress line" },
		{ name: "index", type: "string", help: "0-based step index (required)" },
		{ name: "total", type: "string", help: "total step count (required)" },
		{ name: "phase", type: "string", help: "setup or tutorial (default: tutorial)" },
		{ name: "video", type: "boolean", help: "show the REC badge, matching an auto-playing recording" },
		{ name: "hide-body", type: "boolean", help: "omit the body text box (voice-only video narration)" },
		{ name: "action-missing", type: "boolean", help: "show the 'target not found' warning" },
		{ name: "waiting-for-click", type: "boolean", help: "show the 'click the highlighted element' hint" },
		{ name: "timeout", type: "string", help: "ms to wait for --target to appear before falling back to a centered card (default: 1500)" },
	],
	help: "Render a dg:demo tour step's spotlight + callout card onto the page, via the shared pkg/common/src/tour-overlay.ts renderer",
	changesPage: false,
});
