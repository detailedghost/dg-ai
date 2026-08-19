import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type DaemonHandle, validateDaemonHandle } from "@dg/common";
import type { DgPaths } from "@dg/common/node";

export function readLockfile(paths: DgPaths): DaemonHandle | undefined {
	if (!existsSync(paths.lockfilePath)) return undefined;
	try {
		return validateDaemonHandle(
			JSON.parse(readFileSync(paths.lockfilePath, "utf8")),
		);
	} catch {
		// Corrupt/partial lockfile reads the same as absent — a fresh start reclaims it.
		return undefined;
	}
}

/** Write via a temp file plus rename() so a reader never observes a partial write. */
export function writeLockfileAtomic(
	paths: DgPaths,
	handle: DaemonHandle,
): void {
	mkdirSync(dirname(paths.lockfilePath), { recursive: true, mode: 0o700 });
	const tmp = `${paths.lockfilePath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(handle));
	renameSync(tmp, paths.lockfilePath);
}

export function removeLockfile(paths: DgPaths): void {
	rmSync(paths.lockfilePath, { force: true });
}

export type HealthFetcher = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

/**
 * pid liveness is wrong in both directions (pids recycle) — the only real
 * signal is /health answering with the SAME instanceId the lockfile records.
 */
export async function isDaemonLive(
	handle: DaemonHandle,
	fetchImpl: HealthFetcher = fetch,
	timeoutMs = 1500,
): Promise<boolean> {
	try {
		const resp = await fetchImpl(`http://127.0.0.1:${handle.port}/health`, {
			headers: { Host: `127.0.0.1:${handle.port}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!resp.ok) return false;
		const body = (await resp.json()) as { instanceId?: unknown };
		return body.instanceId === handle.instanceId;
	} catch {
		return false;
	}
}
