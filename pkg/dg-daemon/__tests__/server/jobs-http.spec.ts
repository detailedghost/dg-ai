import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_FEED_PATH, CHAT_JOBS_PATH } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import type { ScheduledJob } from "../../src/store";
import {
	bootServe as bootDaemonServe,
	ChatStore,
	cleanupDgHome,
	createCleanupSlot,
	FILE_ONLY_SEAMS,
	stopServe,
} from "../utils/daemon-harness";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

type Booted = { port: number; dgHome: string };

async function bootServe(): Promise<Booted> {
	const { dgHome, port, proc } = await bootDaemonServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return { port, dgHome };
}

/**
 * The daemon under test runs in its own process, so seeding goes through a second
 * connection to the same database rather than through its store instance.
 */
async function seed(
	dgHome: string,
	write: (store: ChatStore) => void,
): Promise<void> {
	const store = await ChatStore.open(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
		FILE_ONLY_SEAMS,
	);
	try {
		write(store);
	} finally {
		store.close();
	}
}

function headers(port: number, origin: string | null = EXTENSION_ORIGIN) {
	return {
		Host: `127.0.0.1:${port}`,
		...(origin ? { Origin: origin } : {}),
	};
}

async function get(
	port: number,
	path: string,
	origin: string | null = EXTENSION_ORIGIN,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		headers: headers(port, origin),
	});
}

async function post(
	port: number,
	path: string,
	body?: unknown,
	origin: string | null = EXTENSION_ORIGIN,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: {
			...headers(port, origin),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

function seedJob(
	store: ChatStore,
	overrides: Partial<Parameters<ChatStore["insertJob"]>[0]> = {},
): ScheduledJob {
	return store.insertJob({
		label: "jira-sprint",
		argv: ["printf", '{"id":"seeded","title":"Seeded item"}\n'],
		cwd: process.cwd(),
		intervalMs: 15 * 60 * 1000,
		nextRunAt: "2099-01-01T00:00:00.000Z",
		...overrides,
	});
}

describe("GET /jobs", () => {
	it("reports each job with its schedule, last run and unread count", async () => {
		const { port, dgHome } = await bootServe();
		let jobId = "";
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			jobId = job.id;
			store.recordJobRun({
				jobId: job.id,
				ranAt: new Date("2026-09-03T12:00:00.000Z"),
				exitCode: 0,
			});
			store.insertFeedItems(job.id, [
				{ fingerprint: "a", title: "A" },
				{ fingerprint: "b", title: "B" },
			]);
		});

		const resp = await get(port, CHAT_JOBS_PATH);
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { jobs: Record<string, unknown>[] };
		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0]).toMatchObject({
			id: jobId,
			label: "jira-sprint",
			enabled: true,
			intervalMs: 15 * 60 * 1000,
			lastRunAt: "2026-09-03T12:00:00.000Z",
			lastExitCode: 0,
			unread: 2,
		});
	});

	it("reports a failed job's exit code and message", async () => {
		const { port, dgHome } = await bootServe();
		await seed(dgHome, (store) => {
			const job = seedJob(store, { label: "sentry" });
			store.recordJobRun({
				jobId: job.id,
				ranAt: new Date("2026-09-03T12:00:00.000Z"),
				exitCode: 1,
				error: "auth token expired",
			});
		});

		const body = (await (await get(port, CHAT_JOBS_PATH)).json()) as {
			jobs: Record<string, unknown>[];
		};
		expect(body.jobs[0]).toMatchObject({
			lastExitCode: 1,
			lastError: "auth token expired",
		});
	});

	it("reports a paused job as disabled with no unread count of its own", async () => {
		const { port, dgHome } = await bootServe();
		await seed(dgHome, (store) => {
			seedJob(store, { label: "paused", enabled: false });
		});

		const body = (await (await get(port, CHAT_JOBS_PATH)).json()) as {
			jobs: Record<string, unknown>[];
		};
		expect(body.jobs[0]).toMatchObject({ enabled: false, unread: 0 });
	});

	it("never puts the job's argv on the wire", async () => {
		const { port, dgHome } = await bootServe();
		await seed(dgHome, (store) => {
			seedJob(store, { argv: ["jira", "--token", "s3cret"] });
		});

		expect(await (await get(port, CHAT_JOBS_PATH)).text()).not.toContain(
			"s3cret",
		);
	});

	it("answers an empty list when nothing is scheduled", async () => {
		const { port } = await bootServe();
		const body = (await (await get(port, CHAT_JOBS_PATH)).json()) as {
			jobs: unknown[];
		};
		expect(body.jobs).toEqual([]);
	});
});

describe("GET /feed", () => {
	it("returns items newest first with their job id", async () => {
		const { port, dgHome } = await bootServe();
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			store.insertFeedItems(job.id, [
				{ fingerprint: "1", title: "oldest" },
				{ fingerprint: "2", title: "newest", meta: "m", url: "u" },
			]);
		});

		const body = (await (await get(port, CHAT_FEED_PATH)).json()) as {
			items: Record<string, unknown>[];
		};
		expect(body.items.map((item) => item.title)).toEqual(["newest", "oldest"]);
		expect(body.items[0]).toMatchObject({ meta: "m", url: "u", read: false });
	});

	it("filters by job", async () => {
		const { port, dgHome } = await bootServe();
		let wanted = "";
		await seed(dgHome, (store) => {
			const one = seedJob(store, { label: "one" });
			const two = seedJob(store, { label: "two" });
			wanted = one.id;
			store.insertFeedItems(one.id, [{ fingerprint: "a", title: "from one" }]);
			store.insertFeedItems(two.id, [{ fingerprint: "b", title: "from two" }]);
		});

		const body = (await (
			await get(port, `${CHAT_FEED_PATH}?jobId=${wanted}`)
		).json()) as { items: Record<string, unknown>[] };
		expect(body.items).toHaveLength(1);
		expect(body.items[0].title).toBe("from one");
	});

	it("filters to unread, and composes that with the job filter", async () => {
		const { port, dgHome } = await bootServe();
		let jobId = "";
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			jobId = job.id;
			store.insertFeedItems(job.id, [
				{ fingerprint: "a", title: "a" },
				{ fingerprint: "b", title: "b" },
			]);
			const [first] = store.listFeedItems({ jobId: job.id });
			store.markFeedItemRead(first.id);
		});

		const body = (await (
			await get(port, `${CHAT_FEED_PATH}?jobId=${jobId}&unread=true`)
		).json()) as { items: unknown[] };
		expect(body.items).toHaveLength(1);
	});

	it("honours a limit and rejects one that is not a positive number", async () => {
		const { port, dgHome } = await bootServe();
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			store.insertFeedItems(job.id, [
				{ fingerprint: "a", title: "a" },
				{ fingerprint: "b", title: "b" },
			]);
		});

		const limited = (await (
			await get(port, `${CHAT_FEED_PATH}?limit=1`)
		).json()) as { items: unknown[] };
		expect(limited.items).toHaveLength(1);
		expect((await get(port, `${CHAT_FEED_PATH}?limit=nope`)).status).toBe(400);
		expect((await get(port, `${CHAT_FEED_PATH}?limit=0`)).status).toBe(400);
	});
});

describe("feed and job mutations", () => {
	it("marks one item read and refuses an unknown item", async () => {
		const { port, dgHome } = await bootServe();
		let itemId = "";
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			store.insertFeedItems(job.id, [{ fingerprint: "a", title: "a" }]);
			itemId = store.listFeedItems({ jobId: job.id })[0].id;
		});

		expect((await post(port, `${CHAT_FEED_PATH}/${itemId}/read`)).status).toBe(
			200,
		);
		const body = (await (
			await get(port, `${CHAT_FEED_PATH}?unread=true`)
		).json()) as { items: unknown[] };
		expect(body.items).toHaveLength(0);
		expect((await post(port, `${CHAT_FEED_PATH}/missing/read`)).status).toBe(
			404,
		);
	});

	it("marks every item read and reports how many it changed", async () => {
		const { port, dgHome } = await bootServe();
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			store.insertFeedItems(job.id, [
				{ fingerprint: "a", title: "a" },
				{ fingerprint: "b", title: "b" },
			]);
		});

		const resp = await post(port, `${CHAT_FEED_PATH}/read-all`);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ marked: 2 });
	});

	it("queues one agent message for an item and refuses a missing identity", async () => {
		const { port, dgHome } = await bootServe();
		let itemId = "";
		await seed(dgHome, (store) => {
			const job = seedJob(store);
			store.insertFeedItems(job.id, [
				{ fingerprint: "a", title: "Quote export times out" },
			]);
			itemId = store.listFeedItems({ jobId: job.id })[0].id;
		});

		expect(
			(await post(port, `${CHAT_FEED_PATH}/${itemId}/queue`, {})).status,
		).toBe(400);
		const resp = await post(port, `${CHAT_FEED_PATH}/${itemId}/queue`, {
			identity: "reviewer",
		});
		expect(resp.status).toBe(200);

		await seed(dgHome, (store) => {
			const claimed = store.claimNextAgentMessage("reviewer", "other-session");
			expect(claimed?.to).toBe("reviewer");
			expect(claimed?.body).toContain("Quote export times out");
		});
	});

	it("runs a job now and moves its next run forward", async () => {
		const { port, dgHome } = await bootServe();
		let jobId = "";
		await seed(dgHome, (store) => {
			jobId = seedJob(store).id;
		});

		const resp = await post(port, `${CHAT_JOBS_PATH}/${jobId}/run`);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toMatchObject({ inserted: 1, exitCode: 0 });

		await seed(dgHome, (store) => {
			const job = store.getJob(jobId);
			expect(job?.lastRunAt).toBeDefined();
			expect(job?.nextRunAt).not.toBe("2099-01-01T00:00:00.000Z");
			expect(store.listFeedItems({ jobId })).toHaveLength(1);
		});
	});

	it("refuses running an unknown job", async () => {
		const { port } = await bootServe();
		expect((await post(port, `${CHAT_JOBS_PATH}/missing/run`)).status).toBe(
			404,
		);
	});
});

describe("the job routes are gated like the rest of the browser surface", () => {
	it("refuses a request with no Origin", async () => {
		const { port } = await bootServe();
		expect((await get(port, CHAT_JOBS_PATH, null)).status).toBe(400);
		expect((await get(port, CHAT_FEED_PATH, null)).status).toBe(400);
	});

	it("refuses a page origin, which is not the extension", async () => {
		const { port } = await bootServe();
		expect(
			(await get(port, CHAT_JOBS_PATH, "https://evil.example")).status,
		).toBe(400);
		expect(
			(
				await post(
					port,
					`${CHAT_FEED_PATH}/read-all`,
					undefined,
					"https://evil.example",
				)
			).status,
		).toBe(400);
	});

	it("refuses a second extension origin once one has been pinned", async () => {
		const { port, dgHome } = await bootServe();

		const { writeConfig } = await import("../../src/server/config-store");
		writeConfig(resolveDgPaths({ env: { DG_HOME: dgHome } }), {
			pinnedOrigin: EXTENSION_ORIGIN,
		});

		expect((await get(port, CHAT_JOBS_PATH, EXTENSION_ORIGIN)).status).toBe(200);

		const other = "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		const refused = await get(port, CHAT_JOBS_PATH, other);
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("pinned");
	});

	it("refuses a Host header that is not the loopback authority", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_JOBS_PATH}`, {
			headers: { Host: "evil.example", Origin: EXTENSION_ORIGIN },
		});
		expect(resp.status).toBe(400);
	});

	it("refuses the wrong method on a job route", async () => {
		const { port } = await bootServe();
		expect((await post(port, CHAT_JOBS_PATH)).status).toBe(404);
	});
});
