import { existsSync } from "node:fs";
import { DgCliError, EXIT_GENERAL_FAILURE } from "@dg/common";
import { checkExecutable, resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";
import { DispatchScheduler } from "../dispatch";
import { runJobNow } from "../jobs/runner";
import { ChatStore, type ScheduledJob } from "../store";

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 60 * 60_000,
};

const EVERY_RE = /^(\d+)([smh])$/;

/** Read an interval written the way a person writes one: `30s`, `15m`, `2h`. */
export function parseEvery(raw: string): number {
	const match = EVERY_RE.exec(raw.trim());
	if (!match) {
		throw new DgCliError(
			`--every: expected a count and a unit of s, m or h (for example 15m), got "${raw}"`,
			EXIT_GENERAL_FAILURE,
		);
	}
	const count = Number(match[1]);
	if (count <= 0) {
		throw new DgCliError(
			`--every: interval must be greater than zero, got "${raw}"`,
			EXIT_GENERAL_FAILURE,
		);
	}
	return count * UNIT_MS[match[2]];
}

function formatEvery(intervalMs: number): string {
	if (intervalMs % UNIT_MS.h === 0) return `${intervalMs / UNIT_MS.h}h`;
	if (intervalMs % UNIT_MS.m === 0) return `${intervalMs / UNIT_MS.m}m`;
	return `${Math.round(intervalMs / UNIT_MS.s)}s`;
}

function describeState(job: ScheduledJob): string {
	if (!job.enabled) return "paused";
	if (job.lastExitCode !== undefined && job.lastExitCode !== 0) return "failed";
	return "ok";
}

async function withStore<T>(run: (store: ChatStore) => Promise<T>): Promise<T> {
	const store = await ChatStore.open(resolveDgPaths());
	try {
		return await run(store);
	} finally {
		store.close();
	}
}

async function requireJob(
	store: ChatStore,
	label: string,
): Promise<ScheduledJob> {
	const job = store.getJobByLabel(label);
	if (!job) {
		throw new DgCliError(`no job labelled "${label}"`, EXIT_GENERAL_FAILURE);
	}
	return job;
}

export function registerJobCommands(program: Command): void {
	const job = program
		.command("job")
		.description("manage the background jobs the daemon runs on a schedule");

	job
		.command("add")
		.description("schedule a command that prints one JSON object per item")
		.requiredOption("--label <label>", "unique name for the job")
		.requiredOption("--every <interval>", "how often to run it, e.g. 15m")
		.requiredOption("--cwd <path>", "working directory for the command")
		.option("--notify <identity>", "agent identity to queue new items to")
		.argument("[command...]", "the command to run, after a bare --")
		.action(
			async (
				argv: string[],
				options: {
					label: string;
					every: string;
					cwd: string;
					notify?: string;
				},
			) => {
				const intervalMs = parseEvery(options.every);
				if (argv.length === 0) {
					throw new DgCliError(
						"job add: no command given — put it after a bare --",
						EXIT_GENERAL_FAILURE,
					);
				}
				if (!existsSync(options.cwd)) {
					throw new DgCliError(
						`--cwd: no such directory: ${options.cwd}`,
						EXIT_GENERAL_FAILURE,
					);
				}
				const stale = checkExecutable(argv[0]);
				if (stale) {
					throw new DgCliError(`job add: ${stale}`, EXIT_GENERAL_FAILURE);
				}

				await withStore(async (store) => {
					if (store.getJobByLabel(options.label)) {
						throw new DgCliError(
							`a job labelled "${options.label}" already exists`,
							EXIT_GENERAL_FAILURE,
						);
					}
					const created = store.insertJob({
						label: options.label,
						argv,
						cwd: options.cwd,
						intervalMs,
						notifyIdentity: options.notify,
					});
					console.log(
						`added "${created.label}" — every ${formatEvery(intervalMs)}, first run ${created.nextRunAt}`,
					);
				});
			},
		);

	job
		.command("list")
		.description("show every scheduled job and its last result")
		.action(async () => {
			await withStore(async (store) => {
				const jobs = store.listJobs();
				if (jobs.length === 0) {
					console.log("no scheduled jobs — add one with `dg-daemon job add`");
					return;
				}
				const unread = store.countUnreadByJob();
				for (const entry of jobs) {
					const parts = [
						entry.label,
						`every ${formatEvery(entry.intervalMs)}`,
						describeState(entry),
						`last ${entry.lastRunAt ?? "never"}`,
						`next ${entry.enabled ? entry.nextRunAt : "-"}`,
						`unread ${unread[entry.id] ?? 0}`,
					];
					console.log(parts.join("  "));
					if (entry.lastError) console.log(`    ${entry.lastError}`);
				}
			});
		});

	job
		.command("rm")
		.description("remove a job and everything it collected")
		.argument("<label>")
		.action(async (label: string) => {
			await withStore(async (store) => {
				const found = await requireJob(store, label);
				store.deleteJob(found.id);
				console.log(`removed "${label}"`);
			});
		});

	for (const [verb, enabled] of [
		["enable", true],
		["disable", false],
	] as const) {
		job
			.command(verb)
			.description(`${verb} a job without removing it`)
			.argument("<label>")
			.action(async (label: string) => {
				await withStore(async (store) => {
					const found = await requireJob(store, label);
					store.setJobEnabled(found.id, enabled);
					console.log(`${verb}d "${label}"`);
				});
			});
	}

	job
		.command("run")
		.description("run a job now, without waiting for its schedule")
		.argument("<label>")
		.action(async (label: string) => {
			await withStore(async (store) => {
				const found = await requireJob(store, label);
				const outcome = await runJobNow(found.id, {
					store,
					scheduler: new DispatchScheduler(),
					logger: {
						info: (message: string) => console.log(message),
						warn: (message: string) => console.error(message),
					},
				});
				if (!outcome) {
					throw new DgCliError(
						`job "${label}" was not admitted to run`,
						EXIT_GENERAL_FAILURE,
					);
				}
				if (outcome.error) {
					throw new DgCliError(
						`job "${label}" failed: ${outcome.error}`,
						EXIT_GENERAL_FAILURE,
					);
				}
				console.log(
					`ran "${label}" — ${outcome.inserted} new, ${outcome.duplicates} already seen`,
				);
			});
		});
}
