import { randomUUID } from "node:crypto";
import { describeError } from "@dg/common";
import type { DispatchScheduler } from "../dispatch";
import { executeCommand } from "../dispatch/exec";
import { resolveLimits } from "../dispatch/limits";
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
		const error = [result.failureReason, result.stderr.trim()]
			.filter(Boolean)
			.join(": ");
		deps.store.recordJobRun({
			jobId: job.id,
			ranAt,
			exitCode: 1,
			error: error || "command failed",
		});
		return {
			jobId: job.id,
			label: job.label,
			exitCode: 1,
			inserted: 0,
			duplicates: 0,
			error: error || "command failed",
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

	const before = new Set(
		deps.store.listFeedItems({ jobId: job.id }).map((item) => item.fingerprint),
	);
	const counts = deps.store.insertFeedItems(job.id, parsed.items);
	deps.store.recordJobRun({ jobId: job.id, ranAt, exitCode: 0 });

	if (job.notifyIdentity && counts.inserted > 0) {
		const fresh = parsed.items
			.filter((item) => !before.has(item.fingerprint))
			.map((item) => item.title);
		deps.store.insertAgentMessage({
			senderSessionId: SCHEDULER_SESSION_ID,
			senderIdentity: `job:${job.label}`,
			recipientIdentity: job.notifyIdentity,
			id: randomUUID(),
			body: notifyBody(job, fresh),
		});
	}

	return {
		jobId: job.id,
		label: job.label,
		exitCode: 0,
		inserted: counts.inserted,
		duplicates: counts.duplicates,
	};
}

export async function runDueJobs(
	deps: JobRunnerDeps,
): Promise<JobRunOutcome[]> {
	const ranAt = deps.now?.() ?? new Date();
	const outcomes: JobRunOutcome[] = [];

	for (const job of deps.store.dueJobs(ranAt)) {
		const admission = deps.scheduler.tryAdmit(
			SCHEDULER_SESSION_ID,
			job.label,
			resolveLimits(),
		);
		if (!admission.ok) {
			deps.logger.warn(`job ${job.label} skipped: ${admission.reason}`);
			continue;
		}
		try {
			const outcome = await runOne(job, deps, ranAt);
			if (outcome.error) {
				deps.logger.warn(`job ${job.label} failed: ${outcome.error}`);
			} else if (outcome.inserted > 0) {
				deps.logger.info(`job ${job.label} added ${outcome.inserted} item(s)`);
			}
			outcomes.push(outcome);
		} catch (err) {
			const error = describeError(err);
			deps.logger.warn(`job ${job.label} threw: ${error}`);
			deps.store.recordJobRun({ jobId: job.id, ranAt, exitCode: 1, error });
			outcomes.push({
				jobId: job.id,
				label: job.label,
				exitCode: 1,
				inserted: 0,
				duplicates: 0,
				error,
			});
		} finally {
			deps.scheduler.release(SCHEDULER_SESSION_ID);
		}
	}

	return outcomes;
}

export function startJobRunner(deps: JobRunnerDeps): { stop(): void } {
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
	}, JOB_TICK_INTERVAL_MS);
	timer.unref?.();
	return {
		stop: () => clearInterval(timer),
	};
}
