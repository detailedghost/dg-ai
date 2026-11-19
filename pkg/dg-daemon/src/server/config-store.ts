import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	withInstallLockSync,
	writeFileAtomic,
	writeFilePreserving,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";

const WRITE_LOCK = { tries: 40, waitMs: 50 };

export function readConfig(paths: DgPaths): Record<string, unknown> {
	const file = paths.daemonConfigPath;
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function writeConfig(
	paths: DgPaths,
	patch: Record<string, unknown>,
): void {
	assertNotBlocked(paths, "daemon");
	const file = paths.daemonConfigPath;
	ensurePrivateDir(dirname(file));
	withInstallLockSync(
		dirname(file),
		() => {
			const next = { ...readConfig(paths), ...patch };
			writeFileAtomic(file, JSON.stringify(next, null, 2));
		},
		WRITE_LOCK,
	);
}

export function readConfigStrict(paths: DgPaths): Record<string, unknown> {
	assertNotBlocked(paths, "daemon");
	const file = paths.daemonConfigPath;
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${file}: top level must be an object`);
	}
	return parsed as Record<string, unknown>;
}

/** Sets or deletes one `jobs` entry; the caller must hold the config lock. */
export function writeJobEntry(
	paths: DgPaths,
	name: string,
	entry: Record<string, unknown> | undefined,
): void {
	assertNotBlocked(paths, "daemon");
	const file = paths.daemonConfigPath;
	const config = readConfigStrict(paths);
	const current = config.jobs;
	if (current !== undefined && !isRecord(current)) {
		throw new Error(`${file}: "jobs" must be an object`);
	}
	const kept = Object.entries(current ?? {}).filter(([key]) => key !== name);
	const jobs = Object.fromEntries(
		entry === undefined ? kept : [...kept, [name, entry]],
	);
	ensurePrivateDir(dirname(file));
	writeFilePreserving(
		file,
		JSON.stringify({ ...config, jobs }, null, 2),
		0o600,
	);
}
