import { afterEach, describe, expect, it } from "bun:test";
import type { SessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	ChatStore,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	spawnServe,
	waitForHealth,
} from "@dg/dg-daemon/test-harness";
import { runCli } from "./cli-wire";

const FAST_TICK_MS = 120;
const PAST = "2020-01-01T00:00:00.000Z";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

async function withStore<T>(run: (store: ChatStore) => T): Promise<T> {
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

async function bootWithJob(
	notifyIdentity: string | undefined,
	argv: string[],
): Promise<{ port: number; reviewer: SessionBootstrap }> {
	dgHome = freshDgHome();
	await withStore((store) =>
		store.insertJob({
			label: "sentry-unresolved",
			argv,
			cwd: process.cwd(),
			intervalMs: 15 * 60_000,
			nextRunAt: PAST,
			notifyIdentity,
		}),
	);

	const port = allocatePort();
	spawnServe(dgHome, port, { DG_JOB_TICK_MS: String(FAST_TICK_MS) });
	await waitForHealth(port);
	const reviewer = await registerSession(port, { agentIdentity: "reviewer" });
	return { port, reviewer };
}

function recv(
	port: number,
	as: SessionBootstrap,
	args: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return runCli(dgHome, port, ["recv", "--session", as.sessionId, ...args]);
}

function outcomeOf(result: { stdout: string; exitCode: number | null }): {
	outcome: string;
	message?: Record<string, unknown>;
} {
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout.trim());
}

describe("a scheduled job notifying an agent", () => {
	it("reaches the agent's own recv, naming the job as the sender", async () => {
		const { port, reviewer } = await bootWithJob("reviewer", [
			"printf",
			'{"id":"SENTRY-1","title":"TypeError in checkout"}\n',
		]);

		const parsed = outcomeOf(
			await recv(port, reviewer, ["--block", "--timeout", "8000"]),
		);

		expect(parsed.outcome).toBe("delivered");
		expect(parsed.message?.from).toBe("job:sentry-unresolved");
		expect(parsed.message?.to).toBe("reviewer");
		expect(String(parsed.message?.body)).toContain("TypeError in checkout");
	});

	it("says nothing to an agent when the job carries no notify identity", async () => {
		const { port, reviewer } = await bootWithJob(undefined, [
			"printf",
			'{"id":"SENTRY-2","title":"Nobody asked to hear about this"}\n',
		]);

		await until(
			() => withStore((store) => store.listFeedItems()),
			(items) => items.length > 0,
			"collected the item",
		);

		expect(outcomeOf(await recv(port, reviewer)).outcome).toBe("empty");
	});

	it("does not speak twice for the same item on a later run", async () => {
		const { port, reviewer } = await bootWithJob("reviewer", [
			"printf",
			'{"id":"SENTRY-3","title":"Said once"}\n',
		]);

		const first = await recv(port, reviewer, ["--block", "--timeout", "8000"]);
		expect(outcomeOf(first).outcome).toBe("delivered");

		await withStore((store) => {
			const job = store.getJobByLabel("sentry-unresolved");
			if (job) {
				store.recordJobRun({
					jobId: job.id,
					ranAt: new Date(Date.now() - 60_000),
					exitCode: 0,
				});
				store.setJobEnabled(job.id, true);
			}
		});
		await Bun.sleep(FAST_TICK_MS * 6);

		expect(outcomeOf(await recv(port, reviewer)).outcome).toBe("empty");
	});
});

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
