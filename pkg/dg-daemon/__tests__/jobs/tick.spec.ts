import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import type { ChatStore as Store } from "../../src/store";
import {
	allocatePort,
	bootServe,
	ChatStore,
	cleanupDgHome,
	createCleanupSlot,
	FILE_ONLY_SEAMS,
	freshDgHome,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";

const FAST_TICK_MS = 120;
const PAST = "2020-01-01T00:00:00.000Z";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function withStore<T>(
	dgHome: string,
	run: (store: Store) => T,
): Promise<T> {
	const store = await ChatStore.open(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
		FILE_ONLY_SEAMS,
	);
	try {
		return run(store);
	} finally {
		store.close();
	}
}

function printsOneItem(id: string, title: string): string[] {
	return ["printf", `{"id":"${id}","title":"${title}"}\n`];
}

async function until<T>(
	read: () => Promise<T>,
	ready: (value: T) => boolean,
	label: string,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last = await read();
	while (Date.now() < deadline) {
		if (ready(last)) return last;
		await Bun.sleep(25);
		last = await read();
	}
	throw new Error(`the daemon never ${label} within ${timeoutMs}ms`);
}

describe("the daemon's own job tick", () => {
	it("runs a due job without anyone asking, and records the run", async () => {
		const { dgHome, port, proc } = await bootServe({
			DG_JOB_TICK_MS: String(FAST_TICK_MS),
		});
		cleanupSlot.set(async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		});

		const job = await withStore(dgHome, (store) =>
			store.insertJob({
				label: "ticks",
				argv: printsOneItem("tick-1", "Arrived on the tick"),
				cwd: process.cwd(),
				intervalMs: 15 * 60_000,
				nextRunAt: PAST,
			}),
		);

		const items = await until(
			() =>
				withStore(dgHome, (store) => store.listFeedItems({ jobId: job.id })),
			(found) => found.length > 0,
			"ran the due job",
		);

		expect(items[0].title).toBe("Arrived on the tick");

		const after = await withStore(dgHome, (store) => store.getJob(job.id));
		expect(after?.lastExitCode).toBe(0);
		expect(after?.lastRunAt).toBeDefined();
		expect(Date.parse(after?.nextRunAt ?? "")).toBeGreaterThan(Date.now());
		expect(port).toBeGreaterThan(0);
	});

	it("does not run the same job twice before its interval is up", async () => {
		const { dgHome, proc } = await bootServe({
			DG_JOB_TICK_MS: String(FAST_TICK_MS),
		});
		cleanupSlot.set(async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		});

		const job = await withStore(dgHome, (store) =>
			store.insertJob({
				label: "once-per-interval",
				argv: printsOneItem("only-1", "Only once"),
				cwd: process.cwd(),
				intervalMs: 60 * 60_000,
				nextRunAt: PAST,
			}),
		);

		const first = await until(
			() => withStore(dgHome, (store) => store.getJob(job.id)),
			(found) => found?.lastRunAt !== undefined,
			"ran the job a first time",
		);

		await Bun.sleep(FAST_TICK_MS * 6);

		const later = await withStore(dgHome, (store) => store.getJob(job.id));
		expect(later?.lastRunAt).toBe(first?.lastRunAt);
		expect(
			await withStore(dgHome, (store) =>
				store.listFeedItems({ jobId: job.id }),
			),
		).toHaveLength(1);
	});

	it("leaves a disabled job alone however long it ticks", async () => {
		const { dgHome, proc } = await bootServe({
			DG_JOB_TICK_MS: String(FAST_TICK_MS),
		});
		cleanupSlot.set(async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		});

		const job = await withStore(dgHome, (store) =>
			store.insertJob({
				label: "paused",
				argv: printsOneItem("never", "Never"),
				cwd: process.cwd(),
				intervalMs: 15 * 60_000,
				nextRunAt: PAST,
				enabled: false,
			}),
		);

		await Bun.sleep(FAST_TICK_MS * 8);

		const after = await withStore(dgHome, (store) => store.getJob(job.id));
		expect(after?.lastRunAt).toBeUndefined();
		expect(
			await withStore(dgHome, (store) =>
				store.listFeedItems({ jobId: job.id }),
			),
		).toHaveLength(0);
	});

	it("keeps ticking after a job fails, and records why", async () => {
		const { dgHome, proc } = await bootServe({
			DG_JOB_TICK_MS: String(FAST_TICK_MS),
		});
		cleanupSlot.set(async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		});

		const failing = await withStore(dgHome, (store) =>
			store.insertJob({
				label: "fails",
				argv: ["false"],
				cwd: process.cwd(),
				intervalMs: 15 * 60_000,
				nextRunAt: PAST,
			}),
		);
		const healthy = await withStore(dgHome, (store) =>
			store.insertJob({
				label: "healthy",
				argv: printsOneItem("after-failure", "Still running"),
				cwd: process.cwd(),
				intervalMs: 15 * 60_000,
				nextRunAt: PAST,
			}),
		);

		const items = await until(
			() =>
				withStore(dgHome, (store) =>
					store.listFeedItems({ jobId: healthy.id }),
				),
			(found) => found.length > 0,
			"ran the healthy job after the failing one",
		);
		expect(items).toHaveLength(1);

		const broken = await withStore(dgHome, (store) => store.getJob(failing.id));
		expect(broken?.lastExitCode).not.toBe(0);
		expect(broken?.lastError).toBeDefined();
	});
});

describe("an enabled job keeps the daemon alive", () => {
	async function seedThenServe(
		enabled: boolean,
	): Promise<{ dgHome: string; port: number }> {
		const dgHome = freshDgHome();
		await withStore(dgHome, (store) =>
			store.insertJob({
				label: "outlives-the-idle-ttl",
				argv: printsOneItem("survivor", "Survivor"),
				cwd: process.cwd(),
				intervalMs: 15 * 60_000,
				nextRunAt: PAST,
				enabled,
			}),
		);

		const port = allocatePort();
		const proc = spawnServe(dgHome, port, {
			DG_JOB_TICK_MS: String(FAST_TICK_MS),
			DG_IDLE_TTL_MS: "300",
		});
		cleanupSlot.set(async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		});
		await waitForHealth(port);
		return { dgHome, port };
	}

	it("is still answering well past the idle TTL, and has run the job", async () => {
		const { dgHome, port } = await seedThenServe(true);

		await Bun.sleep(1_500);

		const health = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(health.status).toBe(200);

		const items = await withStore(dgHome, (store) => store.listFeedItems());
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe("Survivor");
	});

	it("shuts down on the idle TTL once the only job is disabled", async () => {
		const { port } = await seedThenServe(false);

		let refused = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			await Bun.sleep(100);
			try {
				await fetch(`http://127.0.0.1:${port}/health`, {
					headers: { Host: `127.0.0.1:${port}` },
				});
			} catch {
				refused = true;
				break;
			}
		}
		expect(refused).toBe(true);
	});
});
