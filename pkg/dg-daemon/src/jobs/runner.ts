import { randomUUID } from "node:crypto";
import { describeError, formatDurationMs, parseEvery } from "@dg/common";
import type { DispatchScheduler } from "../dispatch";
import type { ExecResult } from "../dispatch/exec";
import { killProcessGroup } from "../dispatch/exec";
import {
	DISPATCH_MAX_OUTPUT_BYTES,
	DISPATCH_MAX_TIMEOUT_MS,
} from "../dispatch/limits";
import {
	type ChatStore,
	SCHEDULER_SESSION_ID,
	type ScheduledJob,
} from "../store";
import { type JobDecl, type ParsedJob, parseScheduledJobs } from "./config";
import { nextCronRun } from "./cron";
import { jobLogFile, type LauncherDeps, startJobRun } from "./launcher";
import { parseFeedLines } from "./parse";

export const JOB_TICK_INTERVAL_MS = 30_000;

const NOTIFY_PREVIEW_ITEMS = 5;

export type JobRunOutcome = {
	jobId: string;
	label: string;
	exitCode: number;
	inserted: number;
	duplicates: number;
	error?: string;
};

export type JobRunnerLogger = {
	info(message: string): void;
	warn(message: string): void;
};

export type RunProgress = { pid?: number; stopped: boolean };

export type ScheduledExec = (
	decl: JobDecl,
	progress: RunProgress,
) => Promise<ExecResult>;

export type JobRunnerDeps = {
	store: ChatStore;
	scheduler: Pick<
		DispatchScheduler,
		"tryAdmitDaemonWide" | "releaseDaemonWide"
	>;
	logger: JobRunnerLogger;
	loadConfig: () => Record<string, unknown>;
	launcher: LauncherDeps;
	now?: () => Date;
	exec?: ScheduledExec;
};

export type ScheduledStatus = {
	label: string;
	state: "running" | "scheduled" | "disabled" | "invalid";
	pid: number | null;
	restarts: number;
	startedAt: string | null;
	lastExit: string | null;
	logFile: string;
	error: string | null;
	nextRunAt: string | null;
	lastRunAt: string | null;
};

export type RunNowResult =
	| { ok: true; status: ScheduledStatus }
	| { ok: false; kind: "unknown" | "invalid" | "conflict"; error: string };

export type JobRunner = {
	tick(): Array<Promise<JobRunOutcome>>;
	runNow(name: string): RunNowResult;
	stop(name: string): Promise<RunNowResult>;
	stopAll(): Promise<void>;
	knows(name: string): boolean;
	status(): ScheduledStatus[];
	start(tickMs?: number): { stop(): void };
};

const intervalOf = (decl: JobDecl): number | undefined =>
	decl.every === undefined ? undefined : parseEvery(decl.every, "every");

function nextAfter(decl: JobDecl, from: Date): Date {
	if (decl.schedule !== undefined) return nextCronRun(decl.schedule, from);
	return new Date(from.getTime() + (intervalOf(decl) ?? 0));
}

const firstRun = (decl: JobDecl, now: Date): Date =>
	decl.schedule === undefined ? now : nextCronRun(decl.schedule, now);

function scheduleChanged(decl: JobDecl, row: ScheduledJob): boolean {
	return decl.schedule === undefined
		? row.cronExpr !== undefined || row.intervalMs !== intervalOf(decl)
		: row.cronExpr !== decl.schedule;
}

function notifyBody(name: string, titles: string[]): string {
	const shown = titles.slice(0, NOTIFY_PREVIEW_ITEMS);
	const rest = titles.length - shown.length;
	const lines = shown.map((title) => `- ${title}`);
	if (rest > 0) lines.push(`- ...and ${rest} more`);
	return [
		`scheduled job "${name}" reported ${titles.length} new item(s):`,
		...lines,
	].join("\n");
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { store, logger } = deps;
	const inProgress = new Map<
		string,
		RunProgress & { startedAt: Date; done: Promise<unknown> }
	>();
	const warned = new Set<string>();
	const clock = () => deps.now?.() ?? new Date();

	const execDefault: ScheduledExec = async (decl, progress) => {
		let run: ReturnType<typeof startJobRun>;
		try {
			run = startJobRun(decl, deps.launcher);
		} catch (err) {
			return {
				exitOk: false,
				stdout: "",
				stderr: "",
				truncated: false,
				failureReason: `failed to start "${decl.argv[0]}": ${describeError(err)}`,
			};
		}
		progress.pid = run.pid;
		const result = await run.done;
		const base = { stdout: result.stdout, stderr: "", truncated: false };
		if (progress.stopped) {
			return { ...base, exitOk: false, failureReason: "stopped by the owner" };
		}
		if (result.timedOut) {
			const limit = decl.timeoutMs ?? DISPATCH_MAX_TIMEOUT_MS;
			return {
				...base,
				exitOk: false,
				failureReason: `timed out after ${formatDurationMs(limit)}`,
			};
		}
		if (result.readError !== undefined) {
			return {
				...base,
				exitOk: false,
				failureReason: `could not read the output: ${result.readError}`,
			};
		}
		if (result.outputCapped) {
			return {
				...base,
				exitOk: false,
				truncated: true,
				failureReason: `output passed ${DISPATCH_MAX_OUTPUT_BYTES} bytes; command killed`,
			};
		}
		if (result.exitCode !== 0) {
			return {
				...base,
				exitOk: false,
				failureReason: `command exited with status ${result.exitCode}`,
			};
		}
		return { ...base, exitOk: true };
	};
	const exec = deps.exec ?? execDefault;

	async function collect(
		decl: JobDecl,
		job: ScheduledJob,
		ranAt: Date,
		progress: RunProgress,
	): Promise<JobRunOutcome> {
		const outcome = (error?: string, inserted = 0, duplicates = 0) => ({
			jobId: job.id,
			label: decl.name,
			exitCode: error ? 1 : 0,
			inserted,
			duplicates,
			...(error ? { error } : {}),
		});
		const result = await exec(decl, progress);
		if (!result.exitOk) {
			const error = result.failureReason ?? "command failed";
			store.recordJobRun({
				jobId: job.id,
				ranAt,
				exitCode: 1,
				error,
				stderr: result.stderr.trim() || undefined,
			});
			return outcome(error);
		}
		if (!decl.feed) {
			store.recordJobRun({ jobId: job.id, ranAt, exitCode: 0 });
			return outcome();
		}
		const parsed = parseFeedLines(result.stdout);
		if (!parsed.ok) {
			store.recordJobRun({
				jobId: job.id,
				ranAt,
				exitCode: 1,
				error: parsed.error,
			});
			return outcome(parsed.error);
		}
		const counts = store.insertFeedItems(job.id, parsed.items);
		store.recordJobRun({ jobId: job.id, ranAt, exitCode: 0 });
		if (decl.notify && counts.inserted.length > 0) {
			try {
				store.insertAgentMessage({
					senderSessionId: SCHEDULER_SESSION_ID,
					senderIdentity: `job:${decl.name}`,
					recipientIdentity: decl.notify,
					id: randomUUID(),
					body: notifyBody(
						decl.name,
						counts.inserted.map((entry) => entry.title),
					),
				});
			} catch (err) {
				logger.warn(
					`job ${decl.name} collected ${counts.inserted.length} item(s) but could not notify ${decl.notify}: ${describeError(err)}`,
				);
			}
		}
		return outcome(undefined, counts.inserted.length, counts.duplicates);
	}

	function launch(
		decl: JobDecl,
		job: ScheduledJob,
		ranAt: Date,
	): Promise<JobRunOutcome> | undefined {
		const admission = deps.scheduler.tryAdmitDaemonWide();
		if (!admission.ok) {
			logger.warn(`job ${decl.name} skipped: ${admission.reason}`);
			return undefined;
		}
		const progress: RunProgress & { startedAt: Date; done: Promise<unknown> } =
			{ stopped: false, startedAt: ranAt, done: Promise.resolve() };
		const done = (async (): Promise<JobRunOutcome> => {
			try {
				const outcome = await collect(decl, job, ranAt, progress);
				if (outcome.error) {
					logger.warn(`job ${decl.name} failed: ${outcome.error}`);
				} else if (outcome.inserted > 0) {
					logger.info(`job ${decl.name} added ${outcome.inserted} item(s)`);
				}
				return outcome;
			} catch (err) {
				const error = describeError(err);
				logger.warn(`job ${decl.name} threw: ${error}`);
				store.recordJobRun({ jobId: job.id, ranAt, exitCode: 1, error });
				return {
					jobId: job.id,
					label: decl.name,
					exitCode: 1,
					inserted: 0,
					duplicates: 0,
					error,
				};
			} finally {
				deps.scheduler.releaseDaemonWide();
				inProgress.delete(decl.name);
			}
		})();
		progress.done = done;
		inProgress.set(decl.name, progress);
		return done;
	}

	function stateRow(decl: JobDecl, now: Date): ScheduledJob | undefined {
		const found = store.getJobByLabel(decl.name);
		if (found && !found.movedAt) return undefined;
		if (found) return found;
		return store.insertJobState({
			label: decl.name,
			cwd: decl.cwd,
			intervalMs: decl.schedule === undefined ? intervalOf(decl) : undefined,
			cronExpr: decl.schedule,
			nextRunAt: firstRun(decl, now).toISOString(),
		});
	}

	function decls(): ParsedJob[] {
		return parseScheduledJobs(deps.loadConfig());
	}

	function warnOnce(parsed: ParsedJob & { ok: false }): void {
		const key = `${parsed.name}:${parsed.error}`;
		if (warned.has(key)) return;
		warned.add(key);
		logger.warn(
			`job ${parsed.name} is not valid and does not run: ${parsed.error}`,
		);
	}

	function warnUnmoved(name: string): void {
		const key = `${name}:unmoved`;
		if (warned.has(key)) return;
		warned.add(key);
		logger.warn(
			`job ${name} does not run: a scheduled row with this name did not move`,
		);
	}

	function tick(): Array<Promise<JobRunOutcome>> {
		const now = clock();
		const started: Array<Promise<JobRunOutcome>> = [];
		for (const parsed of decls()) {
			if (!parsed.ok) {
				warnOnce(parsed);
				continue;
			}
			const decl = parsed;
			try {
				let job = decl.enabled
					? stateRow(decl, now)
					: store.getJobByLabel(decl.name);
				if (!job?.movedAt) {
					if (decl.enabled) warnUnmoved(decl.name);
					continue;
				}
				if (job.enabled !== decl.enabled) {
					store.setJobEnabled(job.id, decl.enabled);
				}
				if (!decl.enabled) continue;
				if (scheduleChanged(decl, job)) {
					store.setJobSchedule(job.id, {
						intervalMs:
							decl.schedule === undefined ? intervalOf(decl) : undefined,
						cronExpr: decl.schedule,
						nextRunAt: nextAfter(decl, now).toISOString(),
					});
					job = store.getJob(job.id) ?? job;
				}
				if (job.nextRunAt > now.toISOString()) continue;
				if (inProgress.has(decl.name)) {
					store.setJobNextRun(job.id, nextAfter(decl, now).toISOString());
					logger.info(
						`job ${decl.name}: skipped a run, the run before it is not complete`,
					);
					continue;
				}
				const run = launch(decl, job, now);
				if (run) {
					store.setJobNextRun(job.id, nextAfter(decl, now).toISOString());
					started.push(run);
				}
			} catch (err) {
				logger.warn(`job ${decl.name} tick failed: ${describeError(err)}`);
			}
		}
		return started;
	}

	function find(name: string): ParsedJob | undefined {
		return decls().find((row) => row.name === name);
	}

	function statusOf(parsed: ParsedJob): ScheduledStatus {
		const logFile = jobLogFile(deps.launcher.paths.logDir, parsed.name);
		const running = inProgress.get(parsed.name);
		const job = store.getJobByLabel(parsed.name);
		const moved = job?.movedAt ? job : undefined;
		const base = {
			label: parsed.name,
			pid: running?.pid ?? null,
			restarts: 0,
			startedAt: running?.startedAt.toISOString() ?? null,
			lastExit:
				moved?.lastExitCode === undefined ? null : `exit ${moved.lastExitCode}`,
			logFile,
			lastRunAt: moved?.lastRunAt ?? null,
		};
		if (!parsed.ok) {
			return {
				...base,
				state: "invalid",
				error: parsed.error,
				nextRunAt: null,
			};
		}
		const nextRunAt = parsed.enabled
			? (moved?.nextRunAt ?? firstRun(parsed, clock()).toISOString())
			: null;
		return {
			...base,
			state: running ? "running" : parsed.enabled ? "scheduled" : "disabled",
			error: moved?.lastError ?? null,
			nextRunAt,
		};
	}

	function runNow(name: string): RunNowResult {
		const parsed = find(name);
		if (!parsed) {
			return { ok: false, kind: "unknown", error: `no job named "${name}"` };
		}
		if (!parsed.ok) {
			return { ok: false, kind: "invalid", error: parsed.error };
		}
		if (inProgress.has(name)) {
			return {
				ok: false,
				kind: "conflict",
				error: `job "${name}" already runs`,
			};
		}
		const now = clock();
		const isFresh = store.getJobByLabel(name) === undefined;
		const job = stateRow(parsed, now);
		if (!job) {
			return {
				ok: false,
				kind: "invalid",
				error: `job "${name}" has a row that did not move`,
			};
		}
		if (!launch(parsed, job, now)) {
			return {
				ok: false,
				kind: "conflict",
				error: "daemon is at capacity",
			};
		}
		if (isFresh) {
			store.setJobNextRun(job.id, nextAfter(parsed, now).toISOString());
		}
		return { ok: true, status: statusOf(parsed) };
	}

	async function stopRun(name: string): Promise<RunNowResult> {
		const running = inProgress.get(name);
		if (running) {
			running.stopped = true;
			if (running.pid !== undefined) await killProcessGroup(running.pid);
			await running.done;
		}
		const parsed = find(name);
		if (!parsed) {
			return { ok: false, kind: "unknown", error: `no job named "${name}"` };
		}
		return { ok: true, status: statusOf(parsed) };
	}

	return {
		tick,
		runNow,
		stop: stopRun,
		knows: (name) => find(name) !== undefined,
		status: () => decls().map(statusOf),
		async stopAll() {
			await Promise.all([...inProgress.keys()].map((name) => stopRun(name)));
		},
		start(tickMs = JOB_TICK_INTERVAL_MS) {
			const run = () => {
				try {
					tick();
				} catch (err) {
					logger.warn(`job tick failed: ${describeError(err)}`);
				}
			};
			const timer = setInterval(run, tickMs);
			timer.unref?.();
			queueMicrotask(run);
			return { stop: () => clearInterval(timer) };
		},
	};
}

/** Starts each due run and waits for the runs it started; specs use it. */
export async function runDueJobs(
	deps: JobRunnerDeps,
): Promise<JobRunOutcome[]> {
	return Promise.all(createJobRunner(deps).tick());
}
