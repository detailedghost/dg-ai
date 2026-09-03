import { CHAT_FEED_PATH, CHAT_JOBS_PATH } from "@dg/common";
import { findDaemonPort } from "@/lib/daemon-port";

export const DASHBOARD_POLL_MS = 10_000;

export type JobPayload = {
	id: string;
	label: string;
	cwd: string;
	intervalMs: number;
	enabled: boolean;
	nextRunAt: string;
	lastRunAt: string | null;
	lastExitCode: number | null;
	lastError: string | null;
	notifyIdentity: string | null;
	unread: number;
};

export type FeedItemPayload = {
	id: string;
	jobId: string;
	createdAt: string;
	title: string;
	meta: string | null;
	url: string | null;
	read: boolean;
};

export type JobState = "ok" | "failed" | "paused";

export type JobView = {
	id: string;
	label: string;
	source: string;
	state: JobState;
	unread: number;
	every: string;
	when: string;
	detail: string;
	progress: number;
};

export type FeedView = {
	id: string;
	jobId: string;
	title: string;
	meta: string;
	url: string | null;
	unread: boolean;
};

export type DashboardState = {
	jobs: JobPayload[];
	items: FeedItemPayload[];
	selectedJobId?: string;
	offline: boolean;
	loaded: boolean;
};

export type RefreshResult =
	| { ok: true; jobs: JobPayload[]; items: FeedItemPayload[] }
	| { ok: false };

const SOURCES: [RegExp, string][] = [
	[/jira/i, "Jira"],
	[/sentry/i, "Sentry"],
	[/datadog|\bdd\b/i, "Datadog"],
];

/**
 * The daemon withholds argv, so the label is the only signal for a source badge.
 */
export function sourceFromLabel(label: string): string {
	for (const [pattern, name] of SOURCES) {
		if (pattern.test(label)) return name;
	}
	return "Job";
}

export function formatEvery(intervalMs: number): string {
	const hour = 60 * 60_000;
	if (intervalMs % hour === 0) return `every ${intervalMs / hour}h`;
	if (intervalMs % 60_000 === 0) return `every ${intervalMs / 60_000}m`;
	return `every ${Math.max(1, Math.round(intervalMs / 1000))}s`;
}

function humanGap(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${Math.max(1, seconds)}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

export function relativeTime(iso: string | null, now: Date): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "never";
	const delta = then - now.getTime();
	return delta >= 0 ? `in ${humanGap(delta)}` : `${humanGap(-delta)} ago`;
}

export function jobState(job: JobPayload): JobState {
	if (!job.enabled) return "paused";
	if (job.lastExitCode !== null && job.lastExitCode !== 0) return "failed";
	return "ok";
}

/** How far the job has travelled from its last run toward its next, as 0..1. */
export function runProgress(job: JobPayload, now: Date): number {
	if (!job.enabled) return 0;
	const next = Date.parse(job.nextRunAt);
	if (Number.isNaN(next) || job.intervalMs <= 0) return 0;
	const elapsed = job.intervalMs - (next - now.getTime());
	return Math.min(1, Math.max(0, elapsed / job.intervalMs));
}

export function toJobView(job: JobPayload, now: Date): JobView {
	const state = jobState(job);
	return {
		id: job.id,
		label: job.label,
		source: sourceFromLabel(job.label),
		state,
		unread: job.unread,
		every: formatEvery(job.intervalMs),
		when:
			state === "paused"
				? "paused"
				: `next ${relativeTime(job.nextRunAt, now)}`,
		detail:
			state === "failed"
				? `exit ${job.lastExitCode}`
				: `ran ${relativeTime(job.lastRunAt, now)}`,
		progress: runProgress(job, now),
	};
}

export function toFeedView(item: FeedItemPayload, now: Date): FeedView {
	return {
		id: item.id,
		jobId: item.jobId,
		title: item.title,
		meta: [item.meta, relativeTime(item.createdAt, now)]
			.filter((part): part is string => Boolean(part))
			.join(" · "),
		url: item.url,
		unread: !item.read,
	};
}

export function summarize(jobs: JobPayload[]): {
	total: number;
	active: number;
	failed: number;
} {
	return {
		total: jobs.length,
		active: jobs.filter((job) => job.enabled).length,
		failed: jobs.filter((job) => jobState(job) === "failed").length,
	};
}

export function firstFailure(
	jobs: JobPayload[],
	now: Date,
): { jobId: string; label: string; message: string } | undefined {
	const failed = jobs.find((job) => jobState(job) === "failed");
	if (!failed) return undefined;
	return {
		jobId: failed.id,
		label: failed.label,
		message: `failed ${relativeTime(failed.lastRunAt, now)} — exit ${failed.lastExitCode}${
			failed.lastError ? `: ${failed.lastError}` : ""
		}`,
	};
}

export function createDashboardState(): DashboardState {
	return { jobs: [], items: [], offline: false, loaded: false };
}

/**
 * A failed refresh flips the offline flag and keeps whatever was last on screen —
 * blanking the feed because one poll missed is worse than showing it a moment stale.
 */
export function applyRefresh(
	state: DashboardState,
	result: RefreshResult,
): DashboardState {
	if (!result.ok) return { ...state, offline: true };
	const selectedJobId = result.jobs.some(
		(job) => job.id === state.selectedJobId,
	)
		? state.selectedJobId
		: undefined;
	return {
		jobs: result.jobs,
		items: result.items,
		selectedJobId,
		offline: false,
		loaded: true,
	};
}

export function selectJob(
	state: DashboardState,
	jobId: string | undefined,
): DashboardState {
	return { ...state, selectedJobId: jobId };
}

export function visibleItems(state: DashboardState): FeedItemPayload[] {
	if (!state.selectedJobId) return state.items;
	return state.items.filter((item) => item.jobId === state.selectedJobId);
}

export type DashboardApi = {
	baseUrl: string;
	refresh(): Promise<RefreshResult>;
	runJob(jobId: string): Promise<boolean>;
	markRead(itemId: string): Promise<boolean>;
	markAllRead(): Promise<boolean>;
	queueToAgent(itemId: string, identity: string): Promise<boolean>;
};

export function createDashboardApi(baseUrl: string): DashboardApi {
	async function post(path: string, body?: unknown): Promise<boolean> {
		try {
			const res = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				...(body === undefined
					? {}
					: {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						}),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	return {
		baseUrl,
		async refresh(): Promise<RefreshResult> {
			try {
				const [jobsRes, feedRes] = await Promise.all([
					fetch(`${baseUrl}${CHAT_JOBS_PATH}`),
					fetch(`${baseUrl}${CHAT_FEED_PATH}`),
				]);
				if (!jobsRes.ok || !feedRes.ok) return { ok: false };
				const jobs = (await jobsRes.json()) as { jobs: JobPayload[] };
				const feed = (await feedRes.json()) as { items: FeedItemPayload[] };
				return { ok: true, jobs: jobs.jobs, items: feed.items };
			} catch {
				return { ok: false };
			}
		},
		runJob: (jobId) => post(`${CHAT_JOBS_PATH}/${jobId}/run`),
		markRead: (itemId) => post(`${CHAT_FEED_PATH}/${itemId}/read`),
		markAllRead: () => post(`${CHAT_FEED_PATH}/read-all`),
		queueToAgent: (itemId, identity) =>
			post(`${CHAT_FEED_PATH}/${itemId}/queue`, { identity }),
	};
}

export async function connectDashboardApi(): Promise<DashboardApi | undefined> {
	const port = await findDaemonPort();
	if (port === undefined) return undefined;
	return createDashboardApi(`http://127.0.0.1:${port}`);
}
