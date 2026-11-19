import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { DispatchScheduler } from "../../src/dispatch";
import type { ExecResult } from "../../src/dispatch/exec";
import { createJobControl } from "../../src/jobs/control";
import { isDaemonIdle } from "../../src/jobs/idle";
import {
	createJobRunner,
	type JobRunnerDeps,
	runDueJobs,
} from "../../src/jobs/runner";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";
import { until } from "./scheduled-fixtures";

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

let table: Record<string, Record<string, unknown>> = {};
let home = "";

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
		loadConfig: () => ({ jobs: table }),
		launcher: {
			paths: resolveDgPaths({ env: { DG_HOME: home } }),
			daemonUrl: () => "http://127.0.0.1:1",
			logger: { warn: () => {} },
			maxLogBytes: 1_000_000,
		},
	};
}

async function withStore(
	run: (store: ChatStore, dgHome: string) => Promise<void>,
): Promise<void> {
	const dgHome = freshDgHome();
	home = dgHome;
	table = {};
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
	const input = {
		label: "jira-sprint",
		argv: ["jira", "issue", "list"],
		cwd: process.cwd(),
		intervalMs: QUARTER_HOUR_MS,
		nextRunAt: "2026-09-03T11:00:00.000Z",
		...overrides,
	};
	const job = store.insertJob(input);
	store.markJobsMoved([job.id]);
	table[input.label] = {
		argv: input.argv,
		cwd: input.cwd,
		every: "15m",
		feed: true,
		...(overrides.enabled === false ? {} : { enabled: true }),
		...(job.notifyIdentity ? { notify: job.notifyIdentity } : {}),
	};
	return job;
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

	it("keeps a run that collected items a success when the notify queue throws", async () => {
		await withStore(async (store) => {
			const job = addJob(store, { notifyIdentity: "reviewer" });
			const warnings: string[] = [];
			const runnerDeps = deps(
				store,
				succeeds('{"id":"a","title":"A"}\n{"id":"b","title":"B"}'),
			);
			runnerDeps.logger = { info: () => {}, warn: (m) => warnings.push(m) };
			store.insertAgentMessage = () => {
				throw new Error("queue is full");
			};

			const [outcome] = await runDueJobs(runnerDeps);

			expect(outcome.exitCode).toBe(0);
			expect(outcome.inserted).toBe(2);
			expect(outcome.error).toBeUndefined();
			expect(store.getJob(job.id)?.lastExitCode).toBe(0);
			expect(store.getJob(job.id)?.lastError).toBeUndefined();
			expect(warnings.join(" ")).toContain("could not notify reviewer");
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
			const warns: string[] = [];
			const refusing = {
				...deps(store, succeeds('{"id":"a","title":"A"}')),
				logger: { info: () => {}, warn: (line: string) => warns.push(line) },
				scheduler: {
					tryAdmitDaemonWide: () => ({
						ok: false as const,
						reason: "at capacity",
					}),
					releaseDaemonWide: () => {},
				},
			};

			const outcomes = await runDueJobs(refusing);

			expect(outcomes).toHaveLength(0);
			expect(warns).toEqual(["job jira-sprint skipped: at capacity"]);
			expect(store.getJob(job.id)?.nextRunAt).toBe("2026-09-03T11:00:00.000Z");
			expect(store.getJob(job.id)?.lastRunAt).toBeUndefined();
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(0);
		});
	});

	it("releases its admission slot even when the command throws", async () => {
		await withStore(async (store) => {
			addJob(store);
			const released: string[] = [];
			const scheduler = {
				tryAdmitDaemonWide: () => ({ ok: true as const }),
				releaseDaemonWide: () => released.push("slot"),
			};

			await runDueJobs({
				...deps(store, async () => {
					throw new Error("spawn blew up");
				}),
				scheduler,
			});

			expect(released).toEqual(["slot"]);
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

describe("createJobRunner", () => {
	const gate = () => {
		let open: () => void = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { opened, open };
	};
	const entry = (extra: Record<string, unknown> = {}) => ({
		argv: ["printf", ""],
		cwd: process.cwd(),
		every: "15m",
		enabled: true,
		...extra,
	});

	it("makes a state row for an enabled entry with none and runs it at once", async () => {
		await withStore(async (store) => {
			table.fresh = entry({ feed: true });

			const outcomes = await runDueJobs(
				deps(store, succeeds('{"id":"a","title":"A"}')),
			);

			expect(outcomes).toHaveLength(1);
			const row = store.getJobByLabel("fresh");
			expect(row?.movedAt).toBeDefined();
			expect(row?.argv).toEqual([]);
			expect(row?.intervalMs).toBe(QUARTER_HOUR_MS);
			expect(row?.lastExitCode).toBe(0);
		});
	});

	it("makes no state row for a disabled entry", async () => {
		await withStore(async (store) => {
			table.off = entry({ enabled: false });

			await runDueJobs(deps(store, succeeds("")));

			expect(store.getJobByLabel("off")).toBeUndefined();
		});
	});

	it("calculates next_run_at again when the every text changed", async () => {
		await withStore(async (store) => {
			const job = addJob(store, { nextRunAt: "2026-09-03T23:00:00.000Z" });
			table["jira-sprint"] = entry({ every: "1h" });
			const now = new Date("2026-09-03T12:00:00.000Z");

			await runDueJobs(deps(store, succeeds(""), now));

			const after = store.getJob(job.id);
			expect(after?.intervalMs).toBe(60 * 60_000);
			expect(after?.nextRunAt).toBe("2026-09-03T13:00:00.000Z");
		});
	});

	it("skips a time while the run before it is in progress and logs one line", async () => {
		await withStore(async (store) => {
			const job = addJob(store);
			const lines: string[] = [];
			const hold = gate();
			let current = new Date("2026-09-03T12:00:00.000Z");
			const runner = createJobRunner({
				...deps(store, async () => {
					await hold.opened;
					return { exitOk: true, stdout: "", stderr: "", truncated: false };
				}),
				now: () => current,
				logger: { info: (line) => lines.push(line), warn: () => {} },
			});

			const first = runner.tick();
			current = new Date("2026-09-03T12:16:00.000Z");
			const second = runner.tick();
			hold.open();
			await Promise.all(first);

			expect(first).toHaveLength(1);
			expect(second).toHaveLength(0);
			expect(lines).toEqual([
				"job jira-sprint: skipped a run, the run before it is not complete",
			]);
			expect(store.getJob(job.id)?.nextRunAt).toBe("2026-09-03T12:31:00.000Z");
		});
	});

	it("warns once and runs nothing for an entry whose name is a row that did not move", async () => {
		await withStore(async (store) => {
			store.insertJob({
				label: "x",
				argv: ["a"],
				cwd: process.cwd(),
				intervalMs: QUARTER_HOUR_MS,
			});
			table.x = entry();
			const warns: string[] = [];
			const runner = createJobRunner({
				...deps(store, succeeds("")),
				logger: { info: () => {}, warn: (line) => warns.push(line) },
			});

			const first = runner.tick();
			const second = runner.tick();

			expect(first).toHaveLength(0);
			expect(second).toHaveLength(0);
			expect(warns).toEqual([
				"job x does not run: a scheduled row with this name did not move",
			]);
		});
	});

	it("still runs a job whose state row exists after a stop between its insert and its mark", async () => {
		await withStore(async (store) => {
			table.fresh = entry();
			const inserted = store.insertJobState({
				label: "fresh",
				cwd: process.cwd(),
				intervalMs: QUARTER_HOUR_MS,
				nextRunAt: "2026-09-03T11:00:00.000Z",
			});
			expect(inserted.movedAt).toBeDefined();

			const outcomes = await runDueJobs(deps(store, succeeds("")));

			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]?.error).toBeUndefined();
		});
	});

	it("does not run a second time at once after a manual run on a fresh entry", async () => {
		await withStore(async (store) => {
			table.fresh = entry();
			const runner = createJobRunner(deps(store, succeeds("")));

			expect(runner.runNow("fresh").ok).toBe(true);
			await until(
				() => store.getJobByLabel("fresh")?.lastExitCode,
				(code) => code === 0,
				"recorded the manual run",
			);

			expect(runner.tick()).toHaveLength(0);
			expect(store.getJobByLabel("fresh")?.nextRunAt).toBe(
				"2026-09-03T12:15:00.000Z",
			);
		});
	});

	it("ends the process group of a run in progress on stopAll and records stopped by the owner", async () => {
		await withStore(async (store) => {
			table.long = entry({
				argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
			});
			const runner = createJobRunner(deps(store, undefined));

			expect(runner.runNow("long").ok).toBe(true);
			const pid = runner.status().find((row) => row.label === "long")?.pid;
			expect(pid).toBeNumber();
			await runner.stopAll();

			expect(store.getJobByLabel("long")?.lastError).toBe(
				"stopped by the owner",
			);
			expect(() => process.kill(pid as number, 0)).toThrow();
		});
	});

	it("ends a run through runner.stop even when its entry left the config", async () => {
		await withStore(async (store) => {
			table.long = entry({
				argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
			});
			const runner = createJobRunner(deps(store, undefined));
			const control = createJobControl(
				{
					status: () => [],
					start: () => ({ ok: false }),
					stop: async () => ({ ok: false }),
				} as never,
				runner,
			);

			runner.runNow("long");
			const pid = runner.status().find((row) => row.label === "long")?.pid;
			delete table.long;
			const result = await runner.stop("long");

			expect(result).toMatchObject({ ok: false, kind: "unknown" });
			expect(() => process.kill(pid as number, 0)).toThrow();
			expect(control.status()).toEqual([]);
		});
	});

	it("runs a job by hand, records the result and keeps next_run_at", async () => {
		await withStore(async (store) => {
			const job = addJob(store, { nextRunAt: "2026-09-03T23:00:00.000Z" });
			const runner = createJobRunner(deps(store, succeeds("")));

			const started = runner.runNow("jira-sprint");
			await until(
				() => store.getJob(job.id)?.lastExitCode,
				(code) => code === 0,
				"recorded the manual run",
			);

			expect(started.ok).toBe(true);
			expect(store.getJob(job.id)?.lastExitCode).toBe(0);
			expect(store.getJob(job.id)?.nextRunAt).toBe("2026-09-03T23:00:00.000Z");
		});
	});

	it("refuses a second manual run while the first runs", async () => {
		await withStore(async (store) => {
			addJob(store);
			const hold = gate();
			const runner = createJobRunner(
				deps(store, async () => {
					await hold.opened;
					return { exitOk: true, stdout: "", stderr: "", truncated: false };
				}),
			);

			runner.runNow("jira-sprint");
			const second = runner.runNow("jira-sprint");
			hold.open();

			expect(second).toEqual({
				ok: false,
				kind: "conflict",
				error: 'job "jira-sprint" already runs',
			});
			await runner.stopAll();
		});
	});

	it("gives an unknown kind for a name that is not a scheduled entry", async () => {
		await withStore(async (store) => {
			const runner = createJobRunner(deps(store, succeeds("")));

			expect(runner.runNow("ghost")).toMatchObject({
				ok: false,
				kind: "unknown",
			});
		});
	});

	it("reports each scheduled entry with its next run time and state", async () => {
		await withStore(async (store) => {
			addJob(store, { nextRunAt: "2026-09-03T23:00:00.000Z" });
			table.off = entry({ enabled: false });
			const runner = createJobRunner(deps(store, succeeds("")));

			const rows = runner.status();

			expect(rows.map((row) => [row.label, row.state, row.nextRunAt])).toEqual([
				["jira-sprint", "scheduled", "2026-09-03T23:00:00.000Z"],
				["off", "disabled", null],
			]);
		});
	});
});

describe("isDaemonIdle", () => {
	it("is idle only with no sessions, connections, enabled jobs or running services", () => {
		expect(isDaemonIdle(0, 0, 0, 0)).toBe(true);
	});

	it("is not idle while a job is enabled, even with nothing else running", () => {
		expect(isDaemonIdle(0, 0, 1, 0)).toBe(false);
	});

	it("is not idle while a service is running", () => {
		expect(isDaemonIdle(0, 0, 0, 1)).toBe(false);
	});

	it("is not idle while a session or a connection is live", () => {
		expect(isDaemonIdle(1, 0, 0, 0)).toBe(false);
		expect(isDaemonIdle(0, 1, 0, 0)).toBe(false);
	});
});
