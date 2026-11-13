import path from "node:path";
import { oneOf, parseFlag, parseOptionalFlag, wholeNumber } from "@dg/common";
import type { Command } from "commander";
import {
	addItem,
	checklistPath,
	ETA_BUCKETS,
	type EtaBucket,
	markDone,
	readChecklist,
	renderEmoji,
	renderJsonModel,
	renderLong,
	renderPlain,
	setStatus,
	textAtLabel,
	type Status,
	STATUSES,
	updateChecklist,
} from "./index";
import { runSubtree } from "../utils/lazy-command";
import { listJobs } from "../bg/jobs";
import { fileMtime, findStalled, lastLogLine } from "./loops";
import { renderReap, runReap } from "./reap-run";

function minutes(value: string | undefined, name: string, fallback: number): number {
	return parseOptionalFlag(wholeNumber(0), value, name) ?? fallback;
}

function collectPid(value: string, previous: number[] = []): number[] {
	return [...previous, parseFlag(wholeNumber(2), value, "--pid")];
}

function parseEta(value: string): EtaBucket {
	return parseFlag(oneOf(ETA_BUCKETS), value, "--eta");
}

function parseStatusArg(value: string): Status {
	return parseFlag(oneOf(STATUSES), value, "status");
}

function reportMatchFailure(
	verb: string,
	match: string,
	candidates: { label: string; text: string }[],
): never {
	if (candidates.length === 0) {
		throw new Error(`${verb}: no checklist item matches "${match}"`);
	}
	const list = candidates.map((c) => `  ${c.label} ${c.text}`).join("\n");
	throw new Error(
		`${verb}: "${match}" matches ${candidates.length} items; be more specific:\n${list}`,
	);
}

/** Registers the checklist that /dg:stat renders by default, plus --long, --plain and --json views. */
export function registerStat(program: Command): void {
	const stat = program
		.command("stat")
		.description(
			"Track a priority-ordered checklist of agent and user work, for /dg:stat",
		);

	stat
		.command("checklist")
		.description(
			"Print the checklist: emoji view by default, --long for a POSIX table, --plain for ASCII/GFM, --json for data",
		)
		.option("-l, --long", "print a POSIX tab-separated table instead")
		.option("-p, --plain", "print an ASCII, GitHub-flavored-markdown view instead")
		.option("--json", "print the checklist as JSON instead")
		.action((options: { long?: boolean; plain?: boolean; json?: boolean }) => {
			const picked = [options.long, options.plain, options.json].filter(Boolean).length;
			if (picked > 1) throw new Error("checklist: pass only one of --long, --plain, --json");
			const model = readChecklist(checklistPath());
			if (options.json) console.log(JSON.stringify(renderJsonModel(model)));
			else if (options.long) process.stdout.write(renderLong(model));
			else if (options.plain) process.stdout.write(renderPlain(model));
			else process.stdout.write(renderEmoji(model));
		});

	stat
		.command("add")
		.description("Append (or place) a new open checklist item")
		.argument("<text>", "item text")
		.option(
			"--status <name>",
			`one of ${STATUSES.filter((s) => s !== "done").join(", ")} (default queued)`,
		)
		.option("--eta <bucket>", `one of ${ETA_BUCKETS.join(", ")}`)
		.option("--at <n>", "position by the number shown, counted from the first open item (default: end); fails if the item would land elsewhere")
		.option("--under <nOrMatch>", "add as a sub-item of this open top-level item")
		.action(
			async (
				text: string,
				options: { status?: string; eta?: string; at?: string; under?: string },
			) => {
				if (options.status === "done") {
					throw new Error(
						'add: use "stat done <match>" to mark an item done, not --status done',
					);
				}
				if (options.at !== undefined && options.under !== undefined) {
					throw new Error("add: pass only one of --at or --under");
				}
				const status = options.status ? parseStatusArg(options.status) : undefined;
				const eta = options.eta ? parseEta(options.eta) : undefined;
				const at = parseOptionalFlag(wholeNumber(1), options.at, "add: --at");
				const path = checklistPath();
				const result = await updateChecklist(path, (model) => {
					const added = addItem(model, text, { status, eta, at, under: options.under });
					if (!added.ok && "placement" in added) {
						throw new Error(
							`add: --at ${added.placement.wanted} is not reachable; the item would land at position ${added.placement.landsAt} because needs-user and parked items sit after the plan`,
						);
					}
					if (!added.ok) reportMatchFailure("add", options.under ?? "", added.candidates);
					return added;
				});
				console.log(
					JSON.stringify({
						kind: "checklist-item-added",
						order: result.label,
						text: textAtLabel(result.model, result.label),
					}),
				);
			},
		);

	stat
		.command("done")
		.description("Mark the one unfinished item matching <match> as done")
		.argument("<match>", "case-insensitive substring of the item text")
		.action(async (match: string) => {
			const path = checklistPath();
			const result = await updateChecklist(path, (model) => {
				const marked = markDone(model, match);
				if (!marked.ok) reportMatchFailure("done", match, marked.candidates);
				return marked;
			});
			console.log(JSON.stringify({ kind: "checklist-item-done", order: result.label }));
		});

	stat
		.command("status")
		.description(
			"Change an item's status (and optionally its ETA); setting a done item's status away from done reopens it",
		)
		.argument("<match>", "case-insensitive substring of the item text")
		.argument("<name>", `one of ${STATUSES.join(", ")}`)
		.option("--eta <bucket>", `one of ${ETA_BUCKETS.join(", ")}`)
		.action(async (match: string, name: string, options: { eta?: string }) => {
			const status = parseStatusArg(name);
			const eta = options.eta ? parseEta(options.eta) : undefined;
			const path = checklistPath();
			const result = await updateChecklist(path, (model) => {
				const updated = setStatus(model, match, status, eta);
				if (!updated.ok) reportMatchFailure("status", match, updated.candidates);
				return updated;
			});
			console.log(
				JSON.stringify({ kind: "checklist-item-status", order: result.label, status }),
			);
		});

	registerReap(stat);
	registerLoops(stat);
}

function registerReap(stat: Command): void {
	stat
		.command("reap")
		.description(
			"Stop leftover agent processes: orphaned watchers and test runs of this repo, and stuck pgrep wait loops of this session",
		)
		.option("--dry-run", "print what would be stopped and stop nothing")
		.option("--json", "print the report as JSON")
		.option("--cwd <dir>", "repo whose worktrees scope the orphan check (default: the current directory)")
		.option("--min-age <minutes>", "skip orphans younger than this (default 10)")
		.option("--loop-min-age <minutes>", "skip wait loops younger than this (default 60)")
		.option("--session-pid <pid>", "PID of this agent session (default: the nearest claude or codex ancestor)")
		.option("--other-sessions", "also stop stuck wait loops of other live sessions")
		.option("--pid <pid>", "stop only this PID if it still qualifies; repeat for more", collectPid)
		.action(
			async (options: {
				dryRun?: boolean;
				json?: boolean;
				cwd?: string;
				minAge?: string;
				loopMinAge?: string;
				sessionPid?: string;
				otherSessions?: boolean;
				pid?: number[];
			}) => {
				if (process.platform === "win32") {
					console.log(options.json ? JSON.stringify({ supported: false }) : "stat reap: not supported on Windows");
					return;
				}
				const report = await runReap({
					cwd: options.cwd ?? process.cwd(),
					dryRun: !!options.dryRun,
					minAgeMinutes: minutes(options.minAge, "--min-age", 10),
					loopMinAgeMinutes: minutes(options.loopMinAge, "--loop-min-age", 60),
					sessionPid: parseOptionalFlag(wholeNumber(2), options.sessionPid, "--session-pid"),
					otherSessions: !!options.otherSessions,
					pids: options.pid ?? [],
				});
				if (options.json) console.log(JSON.stringify(report));
				else process.stdout.write(renderReap(report));
				if (report.failed.length > 0) process.exitCode = 1;
			},
		);
}

function registerLoops(stat: Command): void {
	stat
		.command("loops")
		.description("List running dg-skills bg jobs whose log stopped growing or that ran too long")
		.option("--json", "print the stalled jobs as JSON")
		.option("--cwd <dir>", "only jobs started in this directory or below (default: the current directory)")
		.option("--stall <minutes>", "flag a job whose log has not grown for this long (default 20)")
		.option("--max-age <minutes>", "flag a job running longer than this (default 180)")
		.action((options: { json?: boolean; cwd?: string; stall?: string; maxAge?: string }) => {
			const stalled = findStalled(listJobs(), {
				cwd: path.resolve(options.cwd ?? process.cwd()),
				now: Date.now(),
				stallMinutes: minutes(options.stall, "--stall", 20),
				maxAgeMinutes: minutes(options.maxAge, "--max-age", 180),
				logMtime: fileMtime,
				lastLine: lastLogLine,
			});
			if (options.json) {
				console.log(JSON.stringify({ stalled }));
				return;
			}
			if (stalled.length === 0) {
				console.log("No stalled bg jobs.");
				return;
			}
			for (const job of stalled)
				console.log(
					`stalled ${job.id} (${job.reason}, idle ${job.idleMinutes}m, age ${job.ageMinutes}m) log ${job.logFile}\n  last: ${job.lastLine}`,
				);
		});
}

export function main(argv: string[]): Promise<void> {
	return runSubtree("stat", registerStat, argv);
}
