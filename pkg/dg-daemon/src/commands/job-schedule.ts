import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	formatIntervalMs,
	isRecord,
	parseEvery,
	CHAT_JOBS_PATH,
} from "@dg/common";
import { isJobName, resolveDgPaths } from "@dg/common/node";
import {
	JOBS_CONFIG_KEY,
	type JobDecl,
	parseJobEntry,
	parseScheduledJobs,
} from "../jobs/config";
import { nextCronRun } from "../jobs/cron";
import { cleanName, rowProblem } from "../jobs/migrate";
import { readConfigStrict, writeJobEntry } from "../server/config-store";
import { ChatStore, type ScheduledJob } from "../store";
import {
	callJobRoute,
	ensureMigrated,
	guardConfig,
	type JobVerbDeps,
	isInTable,
	requireMigrated,
	resolveExecutable,
	withConfigLock,
} from "./job-support";

export type ScheduledRow = {
	name: string;
	mode: "schedule" | "every";
	enabled: boolean;
	schedule: string;
	lastRunAt: string | null;
	nextRunAt: string | null;
	renamedFrom?: string | null;
	invalid?: string;
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
	envFile?: string;
	passEnv?: string[];
	credentials?: string[];
	grant?: string;
	credentialEnv?: Record<string, string>;
};

export type AddedScheduled = {
	label: string;
	nextRunAt: string;
	intervalMs?: number;
	cronExpr?: string;
};

async function withStore<T>(run: (store: ChatStore) => Promise<T>): Promise<T> {
	const store = await ChatStore.open(resolveDgPaths());
	try {
		return await run(store);
	} finally {
		store.close();
	}
}

const fail = (message: string): never => {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
};

const notFound = (name: string): never => fail(`no job named "${name}"`);

function rowOfEntry(
	decl: JobDecl,
	state: ScheduledJob | undefined,
): ScheduledRow {
	return {
		name: decl.name,
		mode: decl.mode === "schedule" ? "schedule" : "every",
		enabled: decl.enabled,
		schedule: decl.schedule ?? decl.every ?? "",
		lastRunAt: state?.lastRunAt ?? null,
		nextRunAt: decl.enabled && state ? state.nextRunAt : null,
		renamedFrom: state?.renamedFrom ?? null,
	};
}

function rowOfUnmoved(job: ScheduledJob): ScheduledRow {
	const name = isJobName(job.label) ? job.label : cleanName(job.label);
	return {
		name: job.label,
		mode: job.cronExpr ? "schedule" : "every",
		enabled: job.enabled,
		schedule: job.cronExpr ?? formatIntervalMs(job.intervalMs ?? 0),
		lastRunAt: job.lastRunAt ?? null,
		nextRunAt: job.enabled ? job.nextRunAt : null,
		renamedFrom: job.renamedFrom ?? null,
		invalid: rowProblem(job, name),
	};
}

export async function listScheduled(): Promise<ScheduledRow[]> {
	const paths = resolveDgPaths();
	const config = guardConfig(() => readConfigStrict(paths));
	const parsed = parseScheduledJobs(config);
	const names = new Set(parsed.map((row) => row.name));
	return withStore(async (store) => {
		const fromTable = parsed.map((row): ScheduledRow => {
			const state = store.getJobByLabel(row.name);
			if (row.ok) return rowOfEntry(row, state?.movedAt ? state : undefined);
			const raw = (config[JOBS_CONFIG_KEY] as Record<string, unknown>)[
				row.name
			];
			const entry = isRecord(raw) ? raw : {};
			return {
				name: row.name,
				mode: Object.hasOwn(entry, "schedule") ? "schedule" : "every",
				enabled: entry.enabled === true,
				schedule: String(entry.schedule ?? entry.every ?? ""),
				lastRunAt: null,
				nextRunAt: null,
				renamedFrom: null,
				invalid: row.error,
			};
		});
		const unmoved = store
			.listUnmovedJobs()
			.filter((job) => !names.has(job.label))
			.map(rowOfUnmoved);
		return [...fromTable, ...unmoved];
	});
}

export async function findScheduled(
	name: string,
): Promise<ScheduledRow | undefined> {
	return (await listScheduled()).find((row) => row.name === name);
}

function scheduleOf(input: AddScheduledInput): {
	entry: { schedule: string } | { every: string };
	added: Pick<AddedScheduled, "intervalMs" | "cronExpr" | "nextRunAt">;
} {
	const now = new Date();
	if (input.schedule !== undefined) {
		try {
			return {
				entry: { schedule: input.schedule },
				added: {
					cronExpr: input.schedule,
					nextRunAt: nextCronRun(input.schedule, now).toISOString(),
				},
			};
		} catch (err) {
			return fail(`--schedule: ${describeError(err)}`);
		}
	}
	const every = input.every ?? "";
	return {
		entry: { every },
		added: { intervalMs: parseEvery(every), nextRunAt: now.toISOString() },
	};
}

export async function addScheduled(
	input: AddScheduledInput,
	which?: JobVerbDeps["which"],
): Promise<AddedScheduled> {
	const paths = resolveDgPaths();
	const exists = () => fail(`a job named "${input.name}" already exists`);
	const { entry: mode, added } = scheduleOf(input);
	if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
		fail(`job add: --cwd: no such directory: ${input.cwd}`);
	}
	const feed = input.feed === true || input.enabled;
	const entry = {
		argv: input.argv,
		cwd: input.cwd,
		...mode,
		...(input.enabled ? { enabled: true } : {}),
		...(feed ? { feed: true } : {}),
		...(input.notify === undefined ? {} : { notify: input.notify }),
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
		...(input.envFile === undefined ? {} : { envFile: input.envFile }),
		...(input.passEnv === undefined || input.passEnv.length === 0
			? {}
			: { passEnv: input.passEnv }),
		...(input.credentials === undefined
			? {}
			: { credentials: input.credentials, grant: input.grant }),
		...(input.credentialEnv === undefined ? {} : { credentialEnv: input.credentialEnv }),
	};
	const parsed = parseJobEntry(input.name, entry);
	if (!parsed.ok) fail(`job add: ${parsed.error}`);
	await ensureMigrated(paths);
	await withConfigLock(paths, async () => {
		const config = guardConfig(() => readConfigStrict(paths));
		requireMigrated(config);
		if (isInTable(config, input.name)) exists();
		const row = await withStore(async (store) =>
			store.getJobByLabel(input.name),
		);
		if (row && !row.movedAt) exists();
		const [first] = input.argv;
		resolveExecutable(
			isAbsolute(first) || !first.includes(sep)
				? first
				: resolve(input.cwd, first),
			"job add:",
			which,
		);
		guardConfig(() => writeJobEntry(paths, input.name, entry));
	});
	return { label: input.name, ...added };
}

async function writeEntry(
	name: string,
	change: (entry: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
	const paths = resolveDgPaths();
	await ensureMigrated(paths);
	await withConfigLock(paths, () => {
		const config = guardConfig(() => readConfigStrict(paths));
		requireMigrated(config);
		const table = config[JOBS_CONFIG_KEY];
		const entry = isRecord(table) ? table[name] : undefined;
		if (!isRecord(entry)) return notFound(name);
		guardConfig(() => writeJobEntry(paths, name, change(entry)));
	});
}

export async function setScheduledEnabled(
	name: string,
	enabled: boolean,
): Promise<void> {
	await writeEntry(name, (entry) => ({ ...entry, enabled }));
}

export async function removeScheduled(name: string): Promise<void> {
	const paths = resolveDgPaths();
	await ensureMigrated(paths);
	await withConfigLock(paths, async () => {
		const config = guardConfig(() => readConfigStrict(paths));
		requireMigrated(config);
		const inTable = isInTable(config, name);
		await withStore(async (store) => {
			const row = store.getJobByLabel(name);
			if (!inTable && (!row || row.movedAt)) notFound(name);
			if (row) store.deleteJob(row.id);
		});
		if (inTable) guardConfig(() => writeJobEntry(paths, name, undefined));
	});
}

export async function runScheduledNow(
	name: string,
): Promise<{ label: string; state: string }> {
	const status = (await callJobRoute(
		`${CHAT_JOBS_PATH}/${encodeURIComponent(name)}/start`,
		"POST",
	)) as { label: string; state: string };
	return status;
}
