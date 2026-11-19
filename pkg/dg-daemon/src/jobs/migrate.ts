import {
	chmodSync,
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatIntervalMs, isRecord } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	isJobName,
	writeFilePreserving,
	writeTarget,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { readConfigStrict } from "../server/config-store";
import type { ChatStore, ScheduledJob } from "../store";
import { JOBS_CONFIG_KEY, parseJobEntry } from "./config";

export const JOBS_VERSION = 2;
export const SERVICES_MARK = 1;
const MARK_KEY = "jobsVersion";

const hasMark = (config: Record<string, unknown>, version: number): boolean =>
	typeof config[MARK_KEY] === "number" && config[MARK_KEY] >= version;

export const isMigrated = (config: Record<string, unknown>): boolean =>
	hasMark(config, JOBS_VERSION);

export const servicesBackupPath = (paths: Pick<DgPaths, "daemonDir">): string =>
	join(paths.daemonDir, "config.json.pre-jobs");

function backupConfig(paths: DgPaths): void {
	try {
		writeFileSync(
			servicesBackupPath(paths),
			readFileSync(writeTarget(paths.daemonConfigPath)),
			{ flag: "wx", mode: 0o600 },
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
}

const SERVICE_KEYS = new Set([
	"argv",
	"cwd",
	"envFile",
	"autostart",
	"passEnv",
	"stopTimeoutMs",
	"grant",
]);

function jobEntryOf(entry: unknown): unknown {
	if (!isRecord(entry)) return entry;
	if (Object.keys(entry).some((key) => !SERVICE_KEYS.has(key))) return entry;
	const { autostart, ...rest } = entry;
	const keepAutostart =
		autostart !== undefined && typeof autostart !== "boolean";
	return {
		...rest,
		...(keepAutostart ? { autostart } : {}),
		...(Object.hasOwn(rest, "continuous") ? {} : { continuous: true }),
		...(autostart === true && !Object.hasOwn(rest, "enabled")
			? { enabled: true }
			: {}),
	};
}

function writeConfigObject(
	paths: DgPaths,
	entries: Array<[string, unknown]>,
): void {
	const file = paths.daemonConfigPath;
	ensurePrivateDir(dirname(file));
	writeFilePreserving(
		file,
		JSON.stringify(Object.fromEntries(entries), null, 2),
		0o600,
	);
}

/** Moves the `services` table into `jobs`; the caller must hold the config lock. */
export function migrateServicesKey(paths: DgPaths): { moved: string[] } {
	const config = readConfigStrict(paths);
	const file = paths.daemonConfigPath;
	const services = config.services;
	const marked = hasMark(config, SERVICES_MARK);
	const mark = marked ? config[MARK_KEY] : SERVICES_MARK;
	const others = Object.entries(config).filter(
		([key]) => key !== "services" && key !== "jobs" && key !== MARK_KEY,
	);
	if (!isRecord(services)) {
		if (marked) return { moved: [] };
		assertNotBlocked(paths, "daemon");
		writeConfigObject(paths, [
			...Object.entries(config).filter(([key]) => key !== MARK_KEY),
			[MARK_KEY, mark],
		]);
		return { moved: [] };
	}
	const current = config.jobs;
	if (current !== undefined && !isRecord(current)) {
		throw new Error(`${file}: "jobs" must be an object`);
	}
	const existing = Object.entries(current ?? {});
	const clash = Object.keys(services).find((name) =>
		Object.hasOwn(current ?? {}, name),
	);
	if (clash !== undefined) {
		throw new Error(
			`${file}: "${clash}" is in "services" and in "jobs" — remove one of them`,
		);
	}
	assertNotBlocked(paths, "daemon");
	backupConfig(paths);
	const moved = Object.entries(services).map(
		([name, entry]): [string, unknown] => [name, jobEntryOf(entry)],
	);
	writeConfigObject(paths, [
		...others,
		["jobs", Object.fromEntries([...existing, ...moved])],
		[MARK_KEY, mark],
	]);
	chmodSync(writeTarget(file), 0o600);
	return { moved: moved.map(([name]) => name) };
}

const MAX_NAME_LENGTH = 64;

export type MigrateRowsLogger = {
	info(message: string): void;
	warn(message: string): void;
};

export type ScheduledRowsResult = {
	moved: string[];
	renamed: Array<{ from: string; to: string }>;
	stuck: Array<{ label: string; reason: string }>;
};

export function rowEntry(job: ScheduledJob): Record<string, unknown> {
	return {
		argv: job.argv,
		cwd: job.cwd,
		...(job.cronExpr
			? { schedule: job.cronExpr }
			: { every: formatIntervalMs(job.intervalMs ?? 0) }),
		...(job.enabled ? { enabled: true } : {}),
		...(job.notifyIdentity ? { notify: job.notifyIdentity } : {}),
		feed: true,
	};
}

/** Why a row cannot become a `jobs` entry, or `undefined` when it can. */
export function rowProblem(
	job: ScheduledJob,
	name: string,
): string | undefined {
	if (job.argvError !== undefined) return "its argv does not decrypt";
	if (!existsSync(job.cwd) || !statSync(job.cwd).isDirectory()) {
		return `its cwd is gone: ${job.cwd}`;
	}
	if (!job.cronExpr && (job.intervalMs ?? 0) % 1000 !== 0) {
		return `its interval is not a whole number of seconds: ${job.intervalMs} ms`;
	}
	const parsed = parseJobEntry(name, rowEntry(job));
	return parsed.ok ? undefined : parsed.error;
}

export function cleanName(label: string): string {
	const cleaned = label
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+/, "")
		.slice(0, MAX_NAME_LENGTH);
	return cleaned === "" ? "job" : cleaned;
}

function chooseName(label: string, isFree: (name: string) => boolean): string {
	const base = isJobName(label) ? label : cleanName(label);
	for (let count = 1; ; count += 1) {
		const suffix = count === 1 ? "" : `-${count}`;
		const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
		if (isJobName(candidate) && isFree(candidate)) return candidate;
	}
}

type RowPlan = {
	job: ScheduledJob;
	name: string;
	write: boolean;
	rename: boolean;
};

/** Moves each row that is not moved into `jobs`; the caller holds the config lock. */
export function migrateScheduledRows(
	store: ChatStore,
	paths: DgPaths,
	logger?: MigrateRowsLogger,
): ScheduledRowsResult {
	const config = readConfigStrict(paths);
	const file = paths.daemonConfigPath;
	const current = config[JOBS_CONFIG_KEY];
	if (current !== undefined && !isRecord(current)) {
		throw new Error(`${file}: "jobs" must be an object`);
	}
	const table: Record<string, unknown> = { ...current };
	const rowLabels = new Set(store.allJobLabels());
	const assigned = new Set<string>();
	const result: ScheduledRowsResult = { moved: [], renamed: [], stuck: [] };
	const plans: RowPlan[] = [];

	for (const job of store.listUnmovedJobs()) {
		const saved = job.renamedFrom !== undefined;
		const keeps = isJobName(job.label) && !saved;
		const written = Object.hasOwn(table, job.label);
		const resumed =
			written &&
			(saved || (keeps && isDeepStrictEqual(table[job.label], rowEntry(job))));
		if (resumed) {
			plans.push({ job, name: job.label, write: false, rename: false });
			assigned.add(job.label);
			continue;
		}
		const name =
			saved && !written
				? job.label
				: chooseName(
						job.label,
						(candidate) =>
							!Object.hasOwn(table, candidate) &&
							!assigned.has(candidate) &&
							(candidate === job.label || !rowLabels.has(candidate)),
					);
		const problem = rowProblem(job, name);
		if (problem !== undefined) {
			result.stuck.push({ label: job.label, reason: problem });
			continue;
		}
		assigned.add(name);
		plans.push({ job, name, write: true, rename: name !== job.label });
	}

	store.saveJobNames(
		plans
			.filter((plan) => plan.rename)
			.map((plan) => ({
				id: plan.job.id,
				label: plan.name,
				renamedFrom: plan.job.label,
			})),
	);

	const entries = plans.filter((plan) => plan.write);
	const mark = isMigrated(config) ? config[MARK_KEY] : JOBS_VERSION;
	if (entries.length > 0 || !isMigrated(config)) {
		assertNotBlocked(paths, "daemon");
		for (const plan of entries) table[plan.name] = rowEntry(plan.job);
		const hasTable = current !== undefined || entries.length > 0;
		const next: Array<[string, unknown]> = [
			...Object.entries(config).filter(
				([key]) => key !== JOBS_CONFIG_KEY && key !== MARK_KEY,
			),
			...(hasTable
				? ([[JOBS_CONFIG_KEY, table]] as Array<[string, unknown]>)
				: []),
			[MARK_KEY, mark],
		];
		writeFilePreserving(
			file,
			JSON.stringify(Object.fromEntries(next), null, 2),
			0o600,
		);
	}

	store.markJobsMoved(plans.map((plan) => plan.job.id));
	for (const plan of plans) result.moved.push(plan.name);
	for (const plan of plans) {
		const from = plan.job.renamedFrom ?? plan.job.label;
		if (from === plan.name) continue;
		result.renamed.push({ from, to: plan.name });
		logger?.info(`scheduled job "${from}" is now "${plan.name}"`);
	}
	for (const { label, reason } of result.stuck) {
		logger?.warn(`scheduled job "${label}" did not move: ${reason}`);
	}
	return result;
}
