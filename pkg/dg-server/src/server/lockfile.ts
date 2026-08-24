import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { type DaemonHandle, validateDaemonHandle } from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import { ensurePrivateDir, writeFileAtomic } from "../utils/fs";

export function readLockfile(paths: DgPaths): DaemonHandle | undefined {
	if (!existsSync(paths.lockfilePath)) return undefined;
	try {
		return validateDaemonHandle(
			JSON.parse(readFileSync(paths.lockfilePath, "utf8")),
		);
	} catch {
		return undefined;
	}
}

export function writeLockfileAtomic(
	paths: DgPaths,
	handle: DaemonHandle,
): void {
	ensurePrivateDir(dirname(paths.lockfilePath));
	writeFileAtomic(paths.lockfilePath, JSON.stringify(handle));
}

export function removeLockfile(paths: DgPaths): void {
	rmSync(paths.lockfilePath, { force: true });
}

export type HealthFetcher = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

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
