import type { FeedItemPayload, JobPayload } from "@/lib/features/dashboard";

export function buildJob(overrides: Partial<JobPayload> = {}): JobPayload {
	return {
		id: "job-1",
		label: "jira-sprint",
		intervalMs: 15 * 60_000,
		enabled: true,
		nextRunAt: "2026-09-03T12:13:00.000Z",
		lastRunAt: "2026-09-03T11:58:00.000Z",
		lastExitCode: 0,
		lastError: null,
		notifyIdentity: null,
		unread: 0,
		...overrides,
	};
}

export function buildFeedItem(
	overrides: Partial<FeedItemPayload> = {},
): FeedItemPayload {
	return {
		id: "item-1",
		jobId: "job-1",
		createdAt: "2026-09-03T11:58:00.000Z",
		title: "Quote export times out",
		meta: "moved to In Review",
		url: null,
		read: false,
		...overrides,
	};
}
