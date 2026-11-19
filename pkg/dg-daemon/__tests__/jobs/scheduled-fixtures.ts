import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import type { InsertJobInput } from "../../src/store";
import { seedJobs } from "../commands/job-cli-helpers";
import {
	allocatePort,
	ChatStore,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	freshTempDir,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";

export const FUTURE = "2099-01-01T00:00:00.000Z";
export const PAST = "2020-01-01T00:00:00.000Z";
export const QUARTER_HOUR_MS = 15 * 60_000;

export const pathsOf = (dgHome: string) =>
	resolveDgPaths({ env: { DG_HOME: dgHome } });

export const configOf = (dgHome: string) =>
	JSON.parse(readFileSync(pathsOf(dgHome).daemonConfigPath, "utf8")) as {
		jobsVersion?: number;
		jobs: Record<string, Record<string, unknown>>;
	};

export const openStoreAt = (dgHome: string): Promise<ChatStore> =>
	ChatStore.open(pathsOf(dgHome), FILE_ONLY_SEAMS);

export const scriptArgv = (script: string): string[] => [
	process.execPath,
	"-e",
	script,
];

export const appendLineArgv = (file: string, text: string): string[] =>
	scriptArgv(
		`require("node:fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(`${text}\n`)})`,
	);

export type RawJob = {
	id: string;
	label: string;
	moved_at: string | null;
	renamed_from: string | null;
	next_run_at: string;
	last_exit_code: number | null;
	argv_ciphertext: Uint8Array;
};

export function rawJob(store: ChatStore, id: string): RawJob {
	const db = (store as unknown as { db: Database }).db;
	return db
		.query("SELECT * FROM scheduled_jobs WHERE id = ?")
		.get(id) as RawJob;
}

export function rawRun(
	store: ChatStore,
	sql: string,
	...params: string[]
): void {
	(store as unknown as { db: Database }).db.run(sql, params);
}

export function rowInput(
	overrides: Partial<InsertJobInput> = {},
): InsertJobInput {
	const cron = overrides.cronExpr !== undefined;
	return {
		label: "jira-sprint",
		argv: ["jira", "issue", "list"],
		cwd: process.cwd(),
		...(cron ? { nextRunAt: FUTURE } : { intervalMs: QUARTER_HOUR_MS }),
		...overrides,
	};
}

export type Booted = {
	dgHome: string;
	port: number;
	proc: ReturnType<typeof spawnServe>;
	dispose: () => Promise<void>;
};

export type BootSeed = {
	jobs?: Record<string, unknown>;
	rows?: InsertJobInput[];
	jobsVersion?: number;
	env?: Record<string, string>;
	dgHome?: string;
	prepare?: (dgHome: string, ids: string[]) => Promise<void>;
};

export async function seedHome(seed: BootSeed = {}): Promise<{
	dgHome: string;
	ids: string[];
}> {
	const dgHome = seed.dgHome ?? freshDgHome();
	seedJobs(dgHome, seed.jobs ?? {}, { jobsVersion: seed.jobsVersion ?? 1 });
	const ids: string[] = [];
	if (seed.rows?.length) {
		const store = await openStoreAt(dgHome);
		try {
			for (const row of seed.rows) ids.push(store.insertJob(row).id);
		} finally {
			store.close();
		}
	}
	return { dgHome, ids };
}

export async function bootSeeded(
	seed: BootSeed = {},
	tickMs = 120,
): Promise<Booted & { ids: string[] }> {
	const { dgHome, ids } = await seedHome(seed);
	await seed.prepare?.(dgHome, ids);
	const port = allocatePort();
	const proc = spawnServe(dgHome, port, {
		DG_JOB_TICK_MS: String(tickMs),
		...seed.env,
	});
	await waitForHealth(port, 8000);
	return {
		dgHome,
		port,
		proc,
		ids,
		dispose: async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		},
	};
}

export async function until<T>(
	read: () => T | Promise<T>,
	ready: (value: T) => boolean,
	label: string,
	timeoutMs = 8_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last = await read();
	while (Date.now() < deadline) {
		if (ready(last)) return last;
		await Bun.sleep(50);
		last = await read();
	}
	throw new Error(`never ${label} within ${timeoutMs}ms`);
}

export async function jobByLabel(dgHome: string, label: string) {
	const store = await openStoreAt(dgHome);
	try {
		return store.getJobByLabel(label);
	} finally {
		store.close();
	}
}

export function tableEntry(
	cwd: string,
	argv: string[],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { every: "1h", enabled: true, argv, cwd, ...extra };
}

export const workDir = (prefix = "sched-cwd"): string => freshTempDir(prefix);

export const lineCount = (file: string): number => {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
};
