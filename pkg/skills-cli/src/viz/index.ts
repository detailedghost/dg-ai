import { cmdAnnotate } from "./features/annotate";
import { cmdClean } from "./features/clean";
import { cmdDismiss } from "./features/dismiss";
import { cmdDoctor } from "./features/doctor";
import { cmdGet } from "./features/get";
import { cmdLink } from "./features/link";
import { cmdList } from "./features/list";
import { cmdMerge } from "./features/merge";
import { cmdNextSteps } from "./features/next-steps";
import { cmdPhase } from "./features/phase";
import { cmdRender } from "./features/render";
import { cmdReview } from "./features/review";
import { cmdStop } from "./features/stop";
import { cmdTrack } from "./features/track";
import { cmdWait } from "./features/wait";
import { die } from "./io";

interface VizVerb {
	args: string;
	summary: string;
	run: (rest: string[]) => void | Promise<void>;
}

const VERBS = new Map<string, VizVerb>([
	[
		"render",
		{
			args: "--input <payload.json> [--no-open]",
			summary: "render payload (ephemeral, temp dir)",
			run: cmdRender,
		},
	],
	[
		"doctor",
		{
			args: "[--json]",
			summary: "probe surface capabilities and report readiness",
			run: cmdDoctor,
		},
	],
	[
		"get",
		{
			args: "<slug> <section|--keys>",
			summary: "read one section (or --keys to list)",
			run: cmdGet,
		},
	],
	[
		"wait",
		{
			args: "<slug> [--merge] [--resume] [--timeout <secs>]",
			summary:
				"block until response; --merge auto-applies; --resume grabs a waiting one",
			run: cmdWait,
		},
	],
	[
		"review-wait",
		{
			args: "<slug> [--timeout <secs>]",
			summary:
				"alias for `wait` — blocks until a submitted review flips all_clear",
			run: cmdWait,
		},
	],
	[
		"merge",
		{
			args: "<slug> [--no-open]",
			summary: "apply response.json → payload, re-render",
			run: cmdMerge,
		},
	],
	[
		"phase",
		{
			args: "<slug> <phase-id> <status>",
			summary: "set a phase's status, re-render (live progress)",
			run: cmdPhase,
		},
	],
	[
		"next-steps",
		{
			args: "<slug> [--set file|--approve|--comment text]",
			summary: "replace, approve, or comment on next steps",
			run: cmdNextSteps,
		},
	],
	[
		"annotate",
		{
			args: "<slug> <patch.json>",
			summary: "patch decision fields, re-render",
			run: cmdAnnotate,
		},
	],
	[
		"review",
		{
			args: "--repo <path> --base <ref> --head <ref> [--spec <specfile>] [--comments <file.json>] [--no-open]",
			summary: "render a view-only code-review board from a git range",
			run: cmdReview,
		},
	],
	[
		"link",
		{
			args: "<slug> <url|label> [--label s] [--kind pr|jira|doc|other] [--status s] [--remove]",
			summary: "upsert/remove a top-of-board link (PRs, docs), re-render",
			run: cmdLink,
		},
	],
	[
		"track",
		{
			args: "<slug> <track-id> <status> [--progress N] [--detail s] [--label s] [--agent s]",
			summary: "write a per-agent track sidecar (atomic, rev-safe)",
			run: cmdTrack,
		},
	],
	[
		"list",
		{ args: "", summary: "list sessions + server status", run: cmdList },
	],
	[
		"dismiss",
		{
			args: "<slug>",
			summary:
				"clear the awaiting-verdict marker without a submitted verdict (--no-wait / cancel)",
			run: cmdDismiss,
		},
	],
	[
		"clean",
		{
			args: "<slug|--all|--orphans>",
			summary: "remove session(s); --orphans drops payload-only staging dirs",
			run: cmdClean,
		},
	],
	["stop", { args: "", summary: "stop the Astro dev server", run: cmdStop }],
]);

function usage(): string {
	const lines = [
		"  dg-skills viz --input <payload.json> [--no-open]   render payload (ephemeral, temp dir)",
	];
	for (const [name, verb] of VERBS) {
		lines.push(
			`${`  dg-skills viz ${name} ${verb.args}`.trimEnd()}\n      ${verb.summary}`,
		);
	}
	return `Usage:\n${lines.join("\n")}\n\n  Env: VIZ_PORT, VIZ_DIR, VIZ_SKILL_DIR\n`;
}

/** Dispatch a viz verb; no verb, a flag or an unknown word falls through to render. */
export async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	if (cmd === "--help" || cmd === "-h") {
		process.stdout.write(usage());
		return 0;
	}
	const verb = cmd ? VERBS.get(cmd) : undefined;
	try {
		if (verb) await verb.run(rest);
		else await cmdRender(cmd ? [cmd, ...rest] : []);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	return 0;
}
