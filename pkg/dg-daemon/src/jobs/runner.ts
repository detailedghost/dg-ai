import { randomUUID } from "node:crypto";
import { describeError } from "@dg/common";
import type { DispatchScheduler } from "../dispatch";
import { executeCommand } from "../dispatch/exec";
import {
	DISPATCH_MAX_CONCURRENT_PER_SESSION,
	resolveLimits,
} from "../dispatch/limits";
import {
	type ChatStore,
	SCHEDULER_SESSION_ID,
	type ScheduledJob,
} from "../store";
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

export type JobRunnerDeps = {
	store: ChatStore;
	scheduler: DispatchScheduler;
	logger: JobRunnerLogger;
	now?: () => Date;
	exec?: typeof executeCommand;
};

function notifyBody(job: ScheduledJob, titles: string[]): string {
	const shown = titles.slice(0, NOTIFY_PREVIEW_ITEMS);
	const rest = titles.length - shown.length;
	const lines = shown.map((title) => `- ${title}`);
	if (rest > 0) lines.push(`- ...and ${rest} more`);
	return [
		`scheduled job "${job.label}" reported ${titles.length} new item(s):`,
		...lines,
	].join("\n");
}

async function runOne(
	job: ScheduledJob,
	deps: JobRunnerDeps,
	ranAt: Date,
): Promise<JobRunOutcome> {
	const exec = deps.exec ?? executeCommand;
	const limits = resolveLimits();
	const result = await exec(job.argv, job.cwd, limits);

	if (!result.exitOk) {
		const error = result.failureReason ?? "command failed";
		deps.store.recordJobRun({
			jobId: job.id,
			ranAt,
			exitCode: 1,
			error,
			stderr: result.stderr.trim() || undefined,
		});
		return {
			jobId: job.id,
			label: job.label,
			exitCode: 1,
			inserted: 0,
			duplicates: 0,
			error,
		};
	}

	const parsed = parseFeedLines(result.stdout);
	if (!parsed.ok) {
		deps.store.recordJobRun({
			jobId: job.id,
			ranAt,
			exitCode: 1,
			error: parsed.error,
		});
		return {
			jobId: job.id,
			label: job.label,
			exitCode: 1,
			inserted: 0,
			duplicates: 0,
			error: parsed.error,
		};
	}

	const counts = deps.store.insertFeedItems(job.id, parsed.items);
	deps.store.recordJobRun({ jobId: job.id, ranAt, exitCode: 0 });

	if (job.notifyIdentity && counts.inserted.length > 0) {
		deps.store.insertAgentMessage({
			senderSessionId: SCHEDULER_SESSION_ID,
			senderIdentity: `job:${job.label}`,
			recipientIdentity: job.notifyIdentity,
			id: randomUUID(),
			body: notifyBody(
				job,
				counts.inserted.map((entry) => entry.title),
			),
		});
	}

	return {
		jobId: job.id,
		label: job.label,
		exitCode: 0,
		inserted: counts.inserted.length,
		duplicates: counts.duplicates,
	};
}

async function admitAndRun(
	job: ScheduledJob,
	deps: JobRunnerDeps,
	ranAt: Date,
): Promise<JobRunOutcome | undefined> {
	const admission = deps.scheduler.tryAdmit(
		SCHEDULER_SESSION_ID,
		job.label,
		resolveLimits(),
	);
	if (!admission.ok) {
		deps.logger.warn(`job ${job.label} skipped: ${admission.reason}`);
		return undefined;
	}
	try {
		const outcome = await runOne(job, deps, ranAt);
		if (outcome.error) {
			deps.logger.warn(`job ${job.label} failed: ${outcome.error}`);
		} else if (outcome.inserted > 0) {
			deps.logger.info(`job ${job.label} added ${outcome.inserted} item(s)`);
		}
		return outcome;
	} catch (err) {
		const error = describeError(err);
		deps.logger.warn(`job ${job.label} threw: ${error}`);
		deps.store.recordJobRun({ jobId: job.id, ranAt, exitCode: 1, error });
		return {
			jobId: job.id,
			label: job.label,
			exitCode: 1,
			inserted: 0,
			duplicates: 0,
			error,
		};
	} finally {
		deps.scheduler.release(SCHEDULER_SESSION_ID);
	}
}

export async function runDueJobs(
	deps: JobRunnerDeps,
): Promise<JobRunOutcome[]> {
	const ranAt = deps.now?.() ?? new Date();
	const queue = deps.store.dueJobs(ranAt);
	const outcomes: JobRunOutcome[] = [];
	let cursor = 0;

	const workers = Array.from(
		{ length: Math.min(DISPATCH_MAX_CONCURRENT_PER_SESSION, queue.length) },
		async () => {
			while (cursor < queue.length) {
				const job = queue[cursor];
				cursor += 1;
				const outcome = await admitAndRun(job, deps, ranAt);
				if (outcome) outcomes.push(outcome);
			}
		},
	);
	await Promise.all(workers);

	return outcomes;
}

/** Run one job off-schedule, for the dashboard's "run now" and the CLI's `job run`. */
export async function runJobNow(
	jobId: string,
	deps: JobRunnerDeps,
): Promise<JobRunOutcome | undefined> {
	const job = deps.store.getJob(jobId);
	if (!job) return undefined;
	return admitAndRun(job, deps, deps.now?.() ?? new Date());
}

export function startJobRunner(
	deps: JobRunnerDeps,
	tickMs = JOB_TICK_INTERVAL_MS,
): { stop(): void } {
	let running = false;
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		void runDueJobs(deps)
			.catch((err: unknown) => {
				deps.logger.warn(`job tick failed: ${describeError(err)}`);
			})
			.finally(() => {
				running = false;
			});
	}, tickMs);
	timer.unref?.();
	return {
		stop: () => clearInterval(timer),
	};
}
