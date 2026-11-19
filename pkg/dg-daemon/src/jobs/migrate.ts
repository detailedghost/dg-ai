import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	writeFilePreserving,
	writeTarget,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { readConfigStrict } from "../server/config-store";

export const JOBS_VERSION = 1;
export const SERVICES_MARK = 1;
const MARK_KEY = "jobsVersion";

export const isMigrated = (config: Record<string, unknown>): boolean =>
	typeof config[MARK_KEY] === "number" && config[MARK_KEY] >= JOBS_VERSION;

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
	const mark = isMigrated(config) ? config[MARK_KEY] : SERVICES_MARK;
	const others = Object.entries(config).filter(
		([key]) => key !== "services" && key !== "jobs" && key !== MARK_KEY,
	);
	if (!isRecord(services)) {
		if (isMigrated(config)) return { moved: [] };
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
