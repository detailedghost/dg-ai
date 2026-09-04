import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { DispatchScheduler } from "../../src/dispatch";
import type { ExecResult } from "../../src/dispatch/exec";
import { isDaemonIdle } from "../../src/jobs/idle";
import { type JobRunnerDeps, runDueJobs } from "../../src/jobs/runner";
import { ChatStore, SCHEDULER_SESSION_ID } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const QUARTER_HOUR_MS = 15 * 60 * 1000;

function succeeds(stdout: string) {
	return async (): Promise<ExecResult> => ({
		exitOk: true,
		stdout,
		stderr: "",
		truncated: false,
	});
}

function fails(failureReason: string, stderr = "") {
	return async (): Promise<ExecResult> => ({
		exitOk: false,
		stdout: "",
		stderr,
		truncated: false,
		failureReason,
	});
}

function deps(
	store: ChatStore,
	exec: JobRunnerDeps["exec"],
	now = new Date("2026-09-03T12:00:00.000Z"),
): JobRunnerDeps {
	return {
		store,
		scheduler: new DispatchScheduler(),
		exec,
		now: () => now,
		logger: { info: () => {}, warn: () => {} },
	};
}

async function withStore(
	run: (store: ChatStore, dgHome: string) => Promise<void>,
): Promise<void> {
	const dgHome = freshDgHome();
	try {
		const store = await ChatStore.open(
			resolveDgPaths({ env: { DG_HOME: dgHome } }),
			FILE_ONLY_SEAMS,
		);
		try {
			await run(store, dgHome);
		} finally {
			store.close();
		}
	} finally {
		cleanupDgHome(dgHome);
	}
}

function addJob(store: ChatStore, overrides: Record<string, unknown> = {}) {
	return store.insertJob({
		label: "jira-sprint",
		argv: ["jira", "issue", "list"],
		cwd: process.cwd(),
		intervalMs: QUARTER_HOUR_MS,
		nextRunAt: "2026-09-03T11:00:00.000Z",
		...overrides,
	});
}

describe("runDueJobs", () => {
	it("turns a successful run's lines into feed items and records the run", async () => {
		await withStore(async (store) => {
			const job = addJob(store);
			const now = new Date("2026-09-03T12:00:00.000Z");

			const outcomes = await runDueJobs(
				deps(
					store,
					succeeds('{"id":"a","title":"A"}\n{"id":"b","title":"B"}\n'),
					now,
				),
			);

			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]).toMatchObject({ jobId: job.id, inserted: 2 });
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(2);

			const after = store.getJob(job.id);
			expect(after?.lastRunAt).toBe(now.toISOString());
			expect(after?.nextRunAt).toBe(
				new Date(now.getTime() + QUARTER_HOUR_MS).toISOString(),
			);
			expect(after?.lastExitCode).toBe(0);
			expect(after?.lastError).toBeUndefined();
		});
	});

	it("reports nothing new on a second run of the same output, and still moves the clock", async () => {
		await withStore(async (store) => {
			const job = addJob(store);
			const exec = succeeds('{"id":"a","title":"A"}');

			await runDueJobs(deps(store, exec, new Date("2026-09-03T12:00:00.000Z")));
			store.setJobEnabled(job.id, true);
			const second = await runDueJobs(
				deps(store, exec, new Date("2026-09-03T12:20:00.000Z")),
			);

			expect(second[0]).toMatchObject({ inserted: 0, duplicates: 1 });
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(1);
			expect(store.getJob(job.id)?.lastRunAt).toBe("2026-09-03T12:20:00.000Z");
		});
	});

	it("records a failed run with its reason and inserts nothing", async () => {
		await withStore(async (store) => {
			const job = addJob(store);

			const outcomes = await runDueJobs(
				deps(
					store,
					fails("command exited with status 1", "auth token expired\n"),
				),
			);

			expect(outcomes[0]).toMatchObject({ jobId: job.id, inserted: 0 });
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(0);

			const after = store.getJob(job.id);
			expect(after?.lastExitCode).not.toBe(0);
			expect(after?.lastError).toBe("command exited with status 1");
			expect(after?.lastStderr).toBe("auth token expired");
		});
	});

	it("still advances the next run after a failure, so one bad job cannot spin", async () => {
		await withStore(async (store) => {
			const job = addJob(store);
			const now = new Date("2026-09-03T12:00:00.000Z");

			await runDueJobs(deps(store, fails("boom"), now));

			expect(store.getJob(job.id)?.nextRunAt).toBe(
				new Date(now.getTime() + QUARTER_HOUR_MS).toISOString(),
			);
			expect(store.dueJobs(now)).toHaveLength(0);
		});
	});

	it("records a parse failure and inserts nothing from that run", async () => {
		await withStore(async (store) => {
			const job = addJob(store);

			const outcomes = await runDueJobs(
				deps(store, succeeds('{"id":"a","title":"A"}\nnot json')),
			);

			expect(outcomes[0]).toMatchObject({ inserted: 0 });
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(0);
			expect(store.getJob(job.id)?.lastError).toContain("line 2");
			expect(store.getJob(job.id)?.lastExitCode).not.toBe(0);
		});
	});

	it("runs only the jobs that are due and enabled", async () => {
		await withStore(async (store) => {
			const due = addJob(store, { label: "due" });
			addJob(store, {
				label: "later",
				nextRunAt: "2026-09-03T23:00:00.000Z",
			});
			addJob(store, { label: "off", enabled: false });

			const outcomes = await runDueJobs(
				deps(store, succeeds('{"id":"a","title":"A"}')),
			);

			expect(outcomes.map((outcome) => outcome.jobId)).toEqual([due.id]);
		});
	});

	it("queues one agent message when a notifying job reports new items", async () => {
		await withStore(async (store) => {
			addJob(store, { notifyIdentity: "reviewer" });

			await runDueJobs(
				deps(store, succeeds('{"id":"a","title":"A"}\n{"id":"b","title":"B"}')),
			);

			const claimed = store.claimNextAgentMessage("reviewer", "other-session");
			expect(claimed?.to).toBe("reviewer");
			expect(claimed?.body).toContain("jira-sprint");
			expect(claimed?.body).toContain("A");
			expect(
				store.claimNextAgentMessage("reviewer", "other-session"),
			).toBeUndefined();
		});
	});

	it("queues nothing when a notifying job reports nothing new", async () => {
		await withStore(async (store) => {
			const job = addJob(store, { notifyIdentity: "reviewer" });
			const exec = succeeds('{"id":"a","title":"A"}');

			await runDueJobs(deps(store, exec));
			store.markAllRead(job.id);
			store.recordJobRun({
				jobId: job.id,
				ranAt: new Date("2026-09-03T11:30:00.000Z"),
				exitCode: 0,
			});
			store.claimNextAgentMessage("reviewer", "other-session");

			await runDueJobs(deps(store, exec, new Date("2026-09-03T13:00:00.000Z")));

			expect(
				store.claimNextAgentMessage("reviewer", "other-session"),
			).toBeUndefined();
		});
	});

	it("queues nothing for a job with no notify identity", async () => {
		await withStore(async (store) => {
			addJob(store);

			await runDueJobs(deps(store, succeeds('{"id":"a","title":"A"}')));

			expect(
				store.claimNextAgentMessage("reviewer", "other-session"),
			).toBeUndefined();
		});
	});

	it("skips a job the admission controller refuses, leaving its clock alone", async () => {
		await withStore(async (store) => {
			const job = addJob(store);
			const refusing = {
				...deps(store, succeeds('{"id":"a","title":"A"}')),
				scheduler: {
					tryAdmit: () => ({ ok: false as const, reason: "at capacity" }),
					release: () => {},
				} as unknown as DispatchScheduler,
			};

			const outcomes = await runDueJobs(refusing);

			expect(outcomes).toHaveLength(0);
			expect(store.getJob(job.id)?.lastRunAt).toBeUndefined();
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(0);
		});
	});

	it("releases its admission slot even when the command throws", async () => {
		await withStore(async (store) => {
			addJob(store);
			const released: string[] = [];
			const scheduler = {
				tryAdmit: () => ({ ok: true as const }),
				release: (sessionId: string) => released.push(sessionId),
			} as unknown as DispatchScheduler;

			await runDueJobs({
				...deps(store, async () => {
					throw new Error("spawn blew up");
				}),
				scheduler,
			});

			expect(released).toEqual([SCHEDULER_SESSION_ID]);
		});
	});

	it("keeps the command's own output out of lastError, which reaches the browser", async () => {
		await withStore(async (store) => {
			const job = addJob(store);

			await runDueJobs(
				deps(store, fails("command exited with status 1", "token=s3cret\n")),
			);

			const after = store.getJob(job.id);
			expect(after?.lastError).not.toContain("s3cret");
			expect(after?.lastStderr).toContain("s3cret");
		});
	});

	it("runs every due job in one tick rather than one per tick", async () => {
		await withStore(async (store) => {
			addJob(store, { label: "one" });
			addJob(store, { label: "two" });
			addJob(store, { label: "three" });

			let peak = 0;
			let live = 0;
			const outcomes = await runDueJobs({
				...deps(store, undefined),
				exec: async () => {
					live += 1;
					peak = Math.max(peak, live);
					await new Promise((resolve) => setTimeout(resolve, 5));
					live -= 1;
					return {
						exitOk: true,
						stdout: '{"id":"a","title":"A"}',
						stderr: "",
						truncated: false,
					};
				},
			});

			expect(outcomes).toHaveLength(3);
			expect(peak).toBeGreaterThan(1);
		});
	});

	it("runs a real command end to end", async () => {
		await withStore(async (store) => {
			const job = addJob(store, {
				argv: ["printf", '{"id":"real-1","title":"From a real process"}\n'],
			});

			const { exec: _unused, ...rest } = deps(store, succeeds(""));
			const outcomes = await runDueJobs(rest);

			expect(outcomes[0]).toMatchObject({ jobId: job.id, inserted: 1 });
			expect(store.listFeedItems({ jobId: job.id })[0].title).toBe(
				"From a real process",
			);
		});
	});
});

describe("isDaemonIdle", () => {
	it("is idle only with no sessions, no connections and no enabled jobs", () => {
		expect(isDaemonIdle(0, 0, 0)).toBe(true);
	});

	it("is not idle while a job is enabled, even with nothing else running", () => {
		expect(isDaemonIdle(0, 0, 1)).toBe(false);
	});

	it("is not idle while a session or a connection is live", () => {
		expect(isDaemonIdle(1, 0, 0)).toBe(false);
		expect(isDaemonIdle(0, 1, 0)).toBe(false);
	});
});
