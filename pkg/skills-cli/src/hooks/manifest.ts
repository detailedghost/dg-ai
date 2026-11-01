import type { HookDefinition } from "./types";

const EDIT_TOOLS = "Edit|Write|MultiEdit";

export const HOOKS: readonly HookDefinition[] = [
	{
		id: "spelling",
		summary:
			"Reject spellings from the other English locale in text written by Edit or Write",
		event: "PostToolUse",
		matcher: EDIT_TOOLS,
		runtimes: ["claude", "codex", "opencode"],
		settings: { locale: { values: ["en-US", "en-GB"], default: "en-US" } },
		load: () => import("./defs/spelling"),
	},
	{
		id: "format",
		summary: "Format the edited file with the formatter installed for its type",
		event: "PostToolUse",
		matcher: EDIT_TOOLS,
		runtimes: ["claude", "codex", "opencode"],
		load: () => import("./defs/format"),
	},
	{
		id: "pr-prose",
		summary: "Block a PR or MR body that does not read as plain English",
		event: "PreToolUse",
		matcher: "Bash",
		runtimes: ["claude", "codex", "opencode"],
		load: () => import("./defs/pr-prose"),
	},
	{
		id: "pr-confirm",
		summary: "Ask before a PR or MR is created",
		event: "PreToolUse",
		matcher: "Bash",
		runtimes: ["claude", "codex"],
		load: () => import("./defs/pr-confirm"),
	},
	{
		id: "spec-plan-lint",
		summary: "Validate a spec plan.md after it is written",
		event: "PostToolUse",
		matcher: EDIT_TOOLS,
		runtimes: ["claude", "codex", "opencode"],
		load: () => import("./defs/spec-plan-lint"),
	},
	{
		id: "daily-prune",
		summary:
			"Once a day, remove scratch and state past TTL and merged clean worktrees",
		event: "SessionStart",
		runtimes: ["claude", "codex"],
		load: () => import("./defs/daily-prune"),
	},
];
