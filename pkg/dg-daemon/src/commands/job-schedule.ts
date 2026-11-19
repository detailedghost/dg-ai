import {
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	formatIntervalMs,
	parseEvery,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { DispatchScheduler } from "../dispatch";
import { nextCronRun } from "../jobs/cron";
import { runJobNow } from "../jobs/runner";
import { readConfigStrict } from "../server/config-store";
import { ChatStore, type ScheduledJob } from "../store";
import { guardConfig, isInTable } from "./job-support";

export type ScheduledRow = {
	name: string;
	mode: "schedule" | "every";
	enabled: boolean;
	schedule: string;
	lastRunAt: string | null;
	nextRunAt: string | null;
	renamedFrom?: string | null;
};

export type AddScheduledInput = {
	name: string;
	argv: string[];
	cwd: string;
	every?: string;
	schedule?: string;
	notify?: string;
	enabled: boolean;
	feed?: boolean;
	timeoutMs?: number;
};

const FEED_TIMEOUT_NOTE =
	"note: --feed and --timeout take effect after the jobs move";

async function withStore<T>(run: (store: ChatStore) => Promise<T>): Promise<T> {
	const store = await ChatStore.open(resolveDgPaths());
	try {
		return await run(store);
	} finally {
		store.close();
	}
}

const rowOf = (job: ScheduledJob): ScheduledRow => ({
	name: job.label,
	mode: job.cronExpr ? "schedule" : "every",
	enabled: job.enabled,
	schedule: job.cronExpr ?? formatIntervalMs(job.intervalMs ?? 0),
	lastRunAt: job.lastRunAt ?? null,
	nextRunAt: job.enabled ? job.nextRunAt : null,
	renamedFrom: null,
});

const notFound = (name: string) =>
	new DgCliError(`no job named "${name}"`, EXIT_GENERAL_FAILURE);

async function requireScheduled(
	store: ChatStore,
	name: string,
): Promise<ScheduledJob> {
	const job = store.getJobByLabel(name);
	if (!job) throw notFound(name);
	return job;
}

export async function addScheduled(
	input: AddScheduledInput,
): Promise<ScheduledJob> {
	const paths = resolveDgPaths();
	const exists = () =>
		new DgCliError(
			`a job named "${input.name}" already exists`,
			EXIT_GENERAL_FAILURE,
		);
	if (isInTable(guardConfig(() => readConfigStrict(paths)), input.name)) {
		throw exists();
	}
	let schedule: { intervalMs: number } | { cronExpr: string; nextRunAt: string };
	if (input.schedule !== undefined) {
		try {
			schedule = {
				cronExpr: input.schedule,
				nextRunAt: nextCronRun(input.schedule, new Date()).toISOString(),
			};
		} catch (err) {
			throw new DgCliError(
				`--schedule: ${describeError(err)}`,
				EXIT_GENERAL_FAILURE,
			);
		}
	} else {
		schedule = { intervalMs: parseEvery(input.every ?? "") };
	}
	return withStore(async (store) => {
		if (store.getJobByLabel(input.name)) throw exists();
		const inserted = store.insertJob({
			label: input.name,
			argv: input.argv,
			cwd: input.cwd,
			...schedule,
			enabled: input.enabled,
			notifyIdentity: input.notify,
		});
		if (input.feed || input.timeoutMs !== undefined) {
			console.error(FEED_TIMEOUT_NOTE);
		}
		return inserted;
	});
}

export async function findScheduled(
	name: string,
): Promise<ScheduledRow | undefined> {
	return withStore(async (store) => {
		const job = store.getJobByLabel(name);
		return job ? rowOf(job) : undefined;
	});
}

export async function setScheduledEnabled(
	name: string,
	enabled: boolean,
): Promise<void> {
	await withStore(async (store) => {
		store.setJobEnabled((await requireScheduled(store, name)).id, enabled);
	});
}

export async function removeScheduled(name: string): Promise<void> {
	await withStore(async (store) => {
		store.deleteJob((await requireScheduled(store, name)).id);
	});
}

export async function runScheduledNow(
	name: string,
): Promise<{ inserted: number; duplicates: number }> {
	return withStore(async (store) => {
		const found = await requireScheduled(store, name);
		const outcome = await runJobNow(found.id, {
			store,
			scheduler: new DispatchScheduler(),
			logger: {
				info: (message: string) => console.log(message),
				warn: (message: string) => console.error(message),
			},
		});
		if (!outcome) {
			throw new DgCliError(
				`job "${name}" was not admitted to run`,
				EXIT_GENERAL_FAILURE,
			);
		}
		if (outcome.error) {
			throw new DgCliError(
				`job "${name}" failed: ${outcome.error}`,
				EXIT_GENERAL_FAILURE,
			);
		}
		return outcome;
	});
}

export async function listScheduled(): Promise<ScheduledRow[]> {
	return withStore(async (store) => store.listJobs().map(rowOf));
}
