import { describe, expect, it } from "bun:test";
import {
	applyRefresh,
	createDashboardApi,
	createDashboardState,
	type FeedItemPayload,
	firstFailure,
	formatEvery,
	type JobPayload,
	jobState,
	relativeTime,
	runProgress,
	selectJob,
	sourceFromLabel,
	summarize,
	toFeedView,
	toJobView,
	visibleItems,
} from "@/lib/features/dashboard";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function job(overrides: Partial<JobPayload> = {}): JobPayload {
	return {
		id: "job-1",
		label: "jira-sprint",
		cwd: "/tmp",
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

function item(overrides: Partial<FeedItemPayload> = {}): FeedItemPayload {
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

describe("job state", () => {
	it("is failed only when an enabled job's last run exited non-zero", () => {
		expect(jobState(job())).toBe("ok");
		expect(jobState(job({ lastExitCode: 1 }))).toBe("failed");
		expect(jobState(job({ lastExitCode: null }))).toBe("ok");
	});

	it("is paused whenever the job is disabled, however its last run went", () => {
		expect(jobState(job({ enabled: false }))).toBe("paused");
		expect(jobState(job({ enabled: false, lastExitCode: 1 }))).toBe("paused");
	});
});

describe("the job row", () => {
	it("shows the schedule and the next run for a healthy job", () => {
		const view = toJobView(job(), NOW);
		expect(view.every).toBe("every 15m");
		expect(view.when).toBe("next in 13m");
		expect(view.detail).toBe("ran 2m ago");
		expect(view.state).toBe("ok");
	});

	it("shows the exit code instead of the last run for a failed job", () => {
		const view = toJobView(job({ lastExitCode: 1 }), NOW);
		expect(view.state).toBe("failed");
		expect(view.detail).toBe("exit 1");
	});

	it("says paused rather than a next run for a disabled job", () => {
		expect(toJobView(job({ enabled: false }), NOW).when).toBe("paused");
	});

	it("takes the unread count from the payload rather than counting items", () => {
		expect(toJobView(job({ unread: 7 }), NOW).unread).toBe(7);
	});

	it("names the source from the label, and falls back when it recognises none", () => {
		expect(sourceFromLabel("jira-jrdev-sprint")).toBe("Jira");
		expect(sourceFromLabel("sentry-unresolved")).toBe("Sentry");
		expect(sourceFromLabel("datadog-prod-errors")).toBe("Datadog");
		expect(sourceFromLabel("nightly-backup")).toBe("Job");
	});
});

describe("time and interval wording", () => {
	it("writes an interval the way it was typed", () => {
		expect(formatEvery(30_000)).toBe("every 30s");
		expect(formatEvery(15 * 60_000)).toBe("every 15m");
		expect(formatEvery(2 * 60 * 60_000)).toBe("every 2h");
	});

	it("writes past and future apart", () => {
		expect(relativeTime("2026-09-03T11:58:00.000Z", NOW)).toBe("2m ago");
		expect(relativeTime("2026-09-03T12:13:00.000Z", NOW)).toBe("in 13m");
	});

	it("says never for a job that has not run, and for a broken timestamp", () => {
		expect(relativeTime(null, NOW)).toBe("never");
		expect(relativeTime("not a date", NOW)).toBe("never");
	});
});

describe("the sweep toward the next run", () => {
	it("is zero right after a run and near one just before the next", () => {
		expect(
			runProgress(job({ nextRunAt: "2026-09-03T12:15:00.000Z" }), NOW),
		).toBeCloseTo(0, 5);
		expect(
			runProgress(job({ nextRunAt: "2026-09-03T12:00:30.000Z" }), NOW),
		).toBeGreaterThan(0.9);
	});

	it("stays inside 0 and 1 for a job that is overdue", () => {
		const overdue = runProgress(
			job({ nextRunAt: "2026-09-03T10:00:00.000Z" }),
			NOW,
		);
		expect(overdue).toBe(1);
	});

	it("is zero for a paused job, which has no next run to travel toward", () => {
		expect(runProgress(job({ enabled: false }), NOW)).toBe(0);
	});
});

describe("the summary strip and the failure banner", () => {
	it("counts jobs, active jobs and failed jobs apart", () => {
		expect(
			summarize([
				job({ id: "a" }),
				job({ id: "b", lastExitCode: 1 }),
				job({ id: "c", enabled: false }),
			]),
		).toEqual({ total: 3, active: 2, failed: 1 });
	});

	it("names the failed job and why, so the banner reads without a click", () => {
		const failure = firstFailure(
			[
				job({ id: "a" }),
				job({
					id: "b",
					label: "sentry-unresolved",
					lastExitCode: 1,
					lastError: "auth token expired",
				}),
			],
			NOW,
		);
		expect(failure?.jobId).toBe("b");
		expect(failure?.label).toBe("sentry-unresolved");
		expect(failure?.message).toContain("exit 1");
		expect(failure?.message).toContain("auth token expired");
	});

	it("has no banner when nothing failed", () => {
		expect(firstFailure([job()], NOW)).toBeUndefined();
	});
});

describe("the feed row", () => {
	it("joins the item's own meta with how long ago it arrived", () => {
		const view = toFeedView(item(), NOW);
		expect(view.meta).toBe("moved to In Review · 2m ago");
		expect(view.unread).toBe(true);
	});

	it("shows only the time when the item carries no meta", () => {
		expect(toFeedView(item({ meta: null }), NOW).meta).toBe("2m ago");
	});

	it("marks a read item as read", () => {
		expect(toFeedView(item({ read: true }), NOW).unread).toBe(false);
	});
});

describe("refreshing", () => {
	it("replaces the jobs and items on a good poll", () => {
		const next = applyRefresh(createDashboardState(), {
			ok: true,
			jobs: [job()],
			items: [item()],
		});
		expect(next.jobs).toHaveLength(1);
		expect(next.items).toHaveLength(1);
		expect(next.offline).toBe(false);
		expect(next.loaded).toBe(true);
	});

	it("goes offline on a failed poll without clearing the last good data", () => {
		const loaded = applyRefresh(createDashboardState(), {
			ok: true,
			jobs: [job()],
			items: [item()],
		});

		const next = applyRefresh(loaded, { ok: false });

		expect(next.offline).toBe(true);
		expect(next.jobs).toHaveLength(1);
		expect(next.items).toHaveLength(1);
	});

	it("comes back online on the next good poll", () => {
		const offline = applyRefresh(createDashboardState(), { ok: false });
		const back = applyRefresh(offline, { ok: true, jobs: [job()], items: [] });
		expect(back.offline).toBe(false);
	});

	it("drops a selection whose job is gone, and keeps one that survives", () => {
		const loaded = selectJob(
			applyRefresh(createDashboardState(), {
				ok: true,
				jobs: [job()],
				items: [],
			}),
			"job-1",
		);

		expect(
			applyRefresh(loaded, { ok: true, jobs: [job()], items: [] })
				.selectedJobId,
		).toBe("job-1");
		expect(
			applyRefresh(loaded, { ok: true, jobs: [], items: [] }).selectedJobId,
		).toBeUndefined();
	});
});

describe("selecting a job", () => {
	it("filters the feed to that job, and shows everything when cleared", () => {
		const loaded = applyRefresh(createDashboardState(), {
			ok: true,
			jobs: [job(), job({ id: "job-2", label: "sentry" })],
			items: [item(), item({ id: "item-2", jobId: "job-2" })],
		});

		expect(visibleItems(selectJob(loaded, "job-2"))).toHaveLength(1);
		expect(visibleItems(selectJob(loaded, "job-2"))[0].id).toBe("item-2");
		expect(visibleItems(selectJob(loaded, undefined))).toHaveLength(2);
	});
});

describe("the api client", () => {
	function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
		const calls: { url: string; init?: RequestInit }[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			return handler(url, init);
		}) as typeof fetch;
		return {
			calls,
			restore: () => {
				globalThis.fetch = original;
			},
		};
	}

	it("reads both jobs and feed in one refresh", async () => {
		const stub = stubFetch((url) =>
			url.includes("/jobs")
				? Response.json({ jobs: [job()] })
				: Response.json({ items: [item()] }),
		);
		try {
			const result = await createDashboardApi("http://127.0.0.1:1").refresh();
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.jobs).toHaveLength(1);
				expect(result.items).toHaveLength(1);
			}
		} finally {
			stub.restore();
		}
	});

	it("reports a refresh as failed when either half is not ok", async () => {
		const stub = stubFetch((url) =>
			url.includes("/jobs")
				? Response.json({ jobs: [] })
				: new Response("nope", { status: 500 }),
		);
		try {
			expect(
				(await createDashboardApi("http://127.0.0.1:1").refresh()).ok,
			).toBe(false);
		} finally {
			stub.restore();
		}
	});

	it("reports a refresh as failed when the daemon is not answering at all", async () => {
		const stub = stubFetch(() => {
			throw new Error("connection refused");
		});
		try {
			expect(
				(await createDashboardApi("http://127.0.0.1:1").refresh()).ok,
			).toBe(false);
		} finally {
			stub.restore();
		}
	});

	it("posts the identity when queueing an item to an agent", async () => {
		const stub = stubFetch(() => Response.json({ ok: true }));
		try {
			const api = createDashboardApi("http://127.0.0.1:1");
			expect(await api.queueToAgent("item-1", "reviewer")).toBe(true);
			const call = stub.calls.at(-1);
			expect(call?.url).toContain("/feed/item-1/queue");
			expect(String(call?.init?.body)).toContain("reviewer");
		} finally {
			stub.restore();
		}
	});

	it("reports a refused mutation rather than throwing", async () => {
		const stub = stubFetch(() => new Response("no", { status: 404 }));
		try {
			const api = createDashboardApi("http://127.0.0.1:1");
			expect(await api.markRead("item-1")).toBe(false);
			expect(await api.runJob("job-1")).toBe(false);
			expect(await api.markAllRead()).toBe(false);
		} finally {
			stub.restore();
		}
	});
});
