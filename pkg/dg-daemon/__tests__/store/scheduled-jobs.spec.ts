import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	applyConnectionPragmas,
	resolveDgPaths,
	runMigrations,
} from "@dg/common/node";
import { ChatStore, SCHEDULER_SESSION_ID } from "../../src/store";
import { SCHEMA_STEPS } from "../../src/store/schema";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const HOUR_MS = 60 * 60 * 1000;

async function openStore(dgHome: string): Promise<ChatStore> {
	return ChatStore.open(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
		FILE_ONLY_SEAMS,
	);
}

function jobInput(overrides: Record<string, unknown> = {}) {
	return {
		label: "jira-sprint",
		argv: ["jira", "issue", "list", "--json"],
		cwd: "/tmp",
		intervalMs: 15 * 60 * 1000,
		...overrides,
	};
}

describe("ChatStore — scheduled jobs", () => {
	it("round-trips argv through the reserved scheduler session AAD across a reopen", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());
			store.close();

			const reopened = await openStore(dgHome);
			const read = reopened.getJob(job.id);
			expect(read?.argv).toEqual(["jira", "issue", "list", "--json"]);
			expect(read?.label).toBe("jira-sprint");
			expect(read?.cwd).toBe("/tmp");
			expect(read?.intervalMs).toBe(15 * 60 * 1000);
			expect(read?.enabled).toBe(true);
			reopened.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("creates the reserved scheduler session row so job-owned rows have a sender", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			const raw = new Database(paths.dbPath, { readonly: true });
			const row = raw
				.query("SELECT id FROM sessions WHERE id = ?")
				.get(SCHEDULER_SESSION_ID) as { id: string } | null;
			expect(row?.id).toBe(SCHEDULER_SESSION_ID);
			raw.close(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses a second job with the same label", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			store.insertJob(jobInput());
			expect(() => store.insertJob(jobInput({ cwd: "/other" }))).toThrow();
			expect(store.listJobs()).toHaveLength(1);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("finds a job by its label", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());
			expect(store.getJobByLabel("jira-sprint")?.id).toBe(job.id);
			expect(store.getJobByLabel("absent")).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("counts only enabled jobs", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const first = store.insertJob(jobInput({ label: "a" }));
			store.insertJob(jobInput({ label: "b" }));
			store.insertJob(jobInput({ label: "c", enabled: false }));

			expect(store.countEnabledJobs()).toBe(2);
			store.setJobEnabled(first.id, false);
			expect(store.countEnabledJobs()).toBe(1);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("returns only enabled jobs whose next run has arrived", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const now = new Date("2026-09-03T12:00:00.000Z");
			const due = store.insertJob(
				jobInput({
					label: "due",
					nextRunAt: new Date(now.getTime() - 1000).toISOString(),
				}),
			);
			store.insertJob(
				jobInput({
					label: "later",
					nextRunAt: new Date(now.getTime() + HOUR_MS).toISOString(),
				}),
			);
			store.insertJob(
				jobInput({
					label: "disabled-but-due",
					enabled: false,
					nextRunAt: new Date(now.getTime() - 1000).toISOString(),
				}),
			);

			expect(store.dueJobs(now).map((job) => job.id)).toEqual([due.id]);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("treats a job due exactly now as due", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const now = new Date("2026-09-03T12:00:00.000Z");
			store.insertJob(jobInput({ nextRunAt: now.toISOString() }));

			expect(store.dueJobs(now)).toHaveLength(1);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("records a successful run and schedules the next one an interval later", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput({ intervalMs: HOUR_MS }));
			const ranAt = new Date("2026-09-03T12:00:00.000Z");

			store.recordJobRun({ jobId: job.id, ranAt, exitCode: 0 });

			const read = store.getJob(job.id);
			expect(read?.lastRunAt).toBe(ranAt.toISOString());
			expect(read?.nextRunAt).toBe(
				new Date(ranAt.getTime() + HOUR_MS).toISOString(),
			);
			expect(read?.lastExitCode).toBe(0);
			expect(read?.lastError).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("stores the failure text of a failed run, encrypted, and clears it on the next success", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const job = store.insertJob(jobInput());

			store.recordJobRun({
				jobId: job.id,
				ranAt: new Date("2026-09-03T12:00:00.000Z"),
				exitCode: 1,
				error: "auth token expired",
			});

			expect(store.getJob(job.id)?.lastExitCode).toBe(1);
			expect(store.getJob(job.id)?.lastError).toBe("auth token expired");

			const raw = new Database(paths.dbPath, { readonly: true });
			const row = raw
				.query("SELECT last_error_ciphertext FROM scheduled_jobs WHERE id = ?")
				.get(job.id) as { last_error_ciphertext: Uint8Array };
			expect(
				Buffer.from(row.last_error_ciphertext).toString("utf8"),
			).not.toContain("auth token expired");
			raw.close(true);

			store.recordJobRun({
				jobId: job.id,
				ranAt: new Date("2026-09-03T12:15:00.000Z"),
				exitCode: 0,
			});
			expect(store.getJob(job.id)?.lastError).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("removes a job's feed items with it and leaves other jobs untouched", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const doomed = store.insertJob(jobInput({ label: "doomed" }));
			const kept = store.insertJob(jobInput({ label: "kept" }));
			store.insertFeedItems(doomed.id, [{ fingerprint: "a", title: "A" }]);
			store.insertFeedItems(kept.id, [{ fingerprint: "b", title: "B" }]);

			expect(store.deleteJob(doomed.id)).toBe(true);

			expect(store.getJob(doomed.id)).toBeUndefined();
			expect(store.listFeedItems({ jobId: doomed.id })).toHaveLength(0);
			expect(store.listFeedItems({ jobId: kept.id })).toHaveLength(1);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

describe("ChatStore — feed items", () => {
	it("inserts new items and reports how many were new", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());

			const result = store.insertFeedItems(job.id, [
				{ fingerprint: "JRDEV-812", title: "Quote export times out" },
				{
					fingerprint: "JRDEV-807",
					title: "Sprint carry-over needs an owner",
					meta: "assigned to you",
					url: "https://example.invalid/JRDEV-807",
				},
			]);

			expect(result).toEqual({ inserted: 2, duplicates: 0 });
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(2);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("is idempotent on (job, fingerprint) so a re-run reports only what is new", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());
			const first = {
				fingerprint: "JRDEV-812",
				title: "Quote export times out",
			};

			expect(store.insertFeedItems(job.id, [first])).toEqual({
				inserted: 1,
				duplicates: 0,
			});
			expect(
				store.insertFeedItems(job.id, [
					first,
					{ fingerprint: "JRDEV-900", title: "New one" },
				]),
			).toEqual({ inserted: 1, duplicates: 1 });

			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(2);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("keeps the same fingerprint apart when two jobs report it", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const one = store.insertJob(jobInput({ label: "one" }));
			const two = store.insertJob(jobInput({ label: "two" }));
			const item = { fingerprint: "shared", title: "Same id, other source" };

			expect(store.insertFeedItems(one.id, [item]).inserted).toBe(1);
			expect(store.insertFeedItems(two.id, [item]).inserted).toBe(1);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("round-trips every item field through the reserved scheduler session AAD", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const job = store.insertJob(jobInput());
			store.insertFeedItems(job.id, [
				{
					fingerprint: "JRDEV-812",
					title: "Quote export times out",
					meta: "moved to In Review",
					url: "https://example.invalid/JRDEV-812",
				},
			]);
			store.close();

			const raw = new Database(paths.dbPath, { readonly: true });
			const row = raw
				.query("SELECT title_ciphertext FROM feed_items")
				.get() as { title_ciphertext: Uint8Array };
			expect(Buffer.from(row.title_ciphertext).toString("utf8")).not.toContain(
				"Quote export",
			);
			raw.close(true);

			const reopened = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const [item] = reopened.listFeedItems({ jobId: job.id });
			expect(item.title).toBe("Quote export times out");
			expect(item.meta).toBe("moved to In Review");
			expect(item.url).toBe("https://example.invalid/JRDEV-812");
			reopened.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("leaves optional fields undefined rather than empty when the job omits them", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());
			store.insertFeedItems(job.id, [{ fingerprint: "a", title: "Bare" }]);

			const [item] = store.listFeedItems({ jobId: job.id });
			expect(item.meta).toBeUndefined();
			expect(item.url).toBeUndefined();
			expect(item.readAt).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("lists newest first and honours the limit", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());
			store.insertFeedItems(job.id, [
				{ fingerprint: "1", title: "oldest" },
				{ fingerprint: "2", title: "middle" },
				{ fingerprint: "3", title: "newest" },
			]);

			const titles = store
				.listFeedItems({ jobId: job.id })
				.map((item) => item.title);
			expect(titles).toEqual(["newest", "middle", "oldest"]);
			expect(store.listFeedItems({ jobId: job.id, limit: 2 })).toHaveLength(2);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("filters to unread, and marking one read drops it from that filter", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const job = store.insertJob(jobInput());
			store.insertFeedItems(job.id, [
				{ fingerprint: "1", title: "one" },
				{ fingerprint: "2", title: "two" },
			]);
			const [first] = store.listFeedItems({ jobId: job.id });

			expect(store.markFeedItemRead(first.id)).toBe(true);
			expect(store.listFeedItems({ unreadOnly: true })).toHaveLength(1);
			expect(store.markFeedItemRead(first.id)).toBe(false);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("marks every unread item read and reports the count", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const one = store.insertJob(jobInput({ label: "one" }));
			const two = store.insertJob(jobInput({ label: "two" }));
			store.insertFeedItems(one.id, [
				{ fingerprint: "a", title: "a" },
				{ fingerprint: "b", title: "b" },
			]);
			store.insertFeedItems(two.id, [{ fingerprint: "c", title: "c" }]);

			expect(store.markAllRead(one.id)).toBe(2);
			expect(store.markAllRead(one.id)).toBe(0);
			expect(store.markAllRead()).toBe(1);
			expect(store.listFeedItems({ unreadOnly: true })).toHaveLength(0);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("counts unread items per job, omitting jobs with none", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await openStore(dgHome);
			const busy = store.insertJob(jobInput({ label: "busy" }));
			const quiet = store.insertJob(jobInput({ label: "quiet" }));
			store.insertFeedItems(busy.id, [
				{ fingerprint: "a", title: "a" },
				{ fingerprint: "b", title: "b" },
			]);
			store.insertFeedItems(quiet.id, [{ fingerprint: "c", title: "c" }]);
			store.markAllRead(quiet.id);

			expect(store.countUnreadByJob()).toEqual({ [busy.id]: 2 });
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

describe("ChatStore — migration to v7", () => {
	it("carries a v6 database forward without losing its rows", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const { mkdirSync } = await import("node:fs");
			mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });

			const seed = new Database(paths.dbPath, { strict: true, create: true });
			applyConnectionPragmas(seed);
			runMigrations(seed, SCHEMA_STEPS.slice(0, 6), {
				snapshotDir: paths.daemonDir,
			});
			expect(
				(seed.query("PRAGMA user_version").get() as { user_version: number })
					.user_version,
			).toBe(6);
			seed.run("INSERT INTO sessions (id, created_at) VALUES (?, ?)", [
				"pre-existing",
				new Date().toISOString(),
			]);
			seed.close(true);

			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(store.userVersion()).toBe(7);
			store.close();

			const raw = new Database(paths.dbPath, { readonly: true });
			const survivor = raw
				.query("SELECT id FROM sessions WHERE id = ?")
				.get("pre-existing") as { id: string } | null;
			expect(survivor?.id).toBe("pre-existing");
			for (const table of ["scheduled_jobs", "feed_items"]) {
				const row = raw
					.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
					.get(table) as { sql: string } | null;
				expect(row?.sql.toUpperCase()).toContain("STRICT");
			}
			raw.close(true);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
