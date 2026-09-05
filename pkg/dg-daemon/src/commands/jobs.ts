import { existsSync } from "node:fs";
import {
	DgCliError,
	deriveJobState,
	describeError,
	EXIT_GENERAL_FAILURE,
	formatIntervalMs,
	parseEvery,
} from "@dg/common";
import { checkExecutableResolves, resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";
import { DispatchScheduler } from "../dispatch";
import { nextCronRun } from "../jobs/cron";
import { runJobNow } from "../jobs/runner";
import { ChatStore, type ScheduledJob } from "../store";

const EVERY_OR_CRON_ERROR =
	"job add: give exactly one of --every or --cron, not both or neither";

type Schedule =
	| { intervalMs: number; cronExpr?: never; nextRunAt?: never }
	| { intervalMs?: never; cronExpr: string; nextRunAt: string };

function resolveSchedule(
	every: string | undefined,
	cron: string | undefined,
): Schedule {
	if (every !== undefined && cron !== undefined) {
		throw new DgCliError(EVERY_OR_CRON_ERROR, EXIT_GENERAL_FAILURE);
	}
	if (cron !== undefined) {
		try {
			return {
				cronExpr: cron,
				nextRunAt: nextCronRun(cron, new Date()).toISOString(),
			};
		} catch (err) {
			throw new DgCliError(
				`--cron: ${describeError(err)}`,
				EXIT_GENERAL_FAILURE,
			);
		}
	}
	if (every === undefined) {
		throw new DgCliError(EVERY_OR_CRON_ERROR, EXIT_GENERAL_FAILURE);
	}
	return { intervalMs: parseEvery(every) };
}

function formatSchedule(
	job: Pick<ScheduledJob, "intervalMs" | "cronExpr">,
): string {
	return job.cronExpr
		? `cron "${job.cronExpr}"`
		: `every ${formatIntervalMs(job.intervalMs ?? 0)}`;
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
		.option("--every <interval>", "how often to run it, e.g. 15m")
		.option("--cron <expression>", 'a cron expression, e.g. "0 9 * * 1-5"')
		.requiredOption("--cwd <path>", "working directory for the command")
		.option("--notify <identity>", "agent identity to queue new items to")
		.argument("[command...]", "the command to run, after a bare --")
		.action(
			async (
				argv: string[],
				options: {
					label: string;
					every?: string;
					cron?: string;
					cwd: string;
					notify?: string;
				},
			) => {
				const schedule = resolveSchedule(options.every, options.cron);
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
				const stale = checkExecutableResolves(argv[0]);
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
						...schedule,
						notifyIdentity: options.notify,
					});
					console.log(
						`added "${created.label}" — ${formatSchedule(created)}, first run ${created.nextRunAt}`,
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
						formatSchedule(entry),
						deriveJobState(entry.enabled, entry.lastExitCode),
						`last ${entry.lastRunAt ?? "never"}`,
						`next ${entry.enabled ? entry.nextRunAt : "-"}`,
						`unread ${unread[entry.id] ?? 0}`,
					];
					console.log(parts.join("  "));
					if (entry.lastError) console.log(`    ${entry.lastError}`);
					if (entry.lastStderr) console.log(`    ${entry.lastStderr}`);
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
