import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
	CHAT_HEALTH_PATH,
	type DaemonHandle,
	validateDaemonHandle,
} from "../chat-format";
import { ensurePrivateDir, writeFileAtomic } from "./fs";
import type { DgPaths } from "./paths";

export function readPidFile(paths: DgPaths): DaemonHandle | undefined {
	if (!existsSync(paths.pidPath)) return undefined;
	try {
		return validateDaemonHandle(
			JSON.parse(readFileSync(paths.pidPath, "utf8")),
		);
	} catch {
		return undefined;
	}
}

export function writePidFileAtomic(paths: DgPaths, handle: DaemonHandle): void {
	ensurePrivateDir(dirname(paths.pidPath));
	writeFileAtomic(paths.pidPath, JSON.stringify(handle));
}

export function removePidFile(paths: DgPaths): void {
	rmSync(paths.pidPath, { force: true });
}

type HealthFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function loopbackHostHeader(port: number): { Host: string } {
	return { Host: `127.0.0.1:${port}` };
}

export async function isDaemonLive(
	handle: DaemonHandle,
	fetchImpl: HealthFetcher = fetch,
	timeoutMs = 1500,
): Promise<boolean> {
	try {
		const resp = await fetchImpl(
			`http://127.0.0.1:${handle.port}${CHAT_HEALTH_PATH}`,
			{
				headers: loopbackHostHeader(handle.port),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		if (!resp.ok) return false;
		const body = (await resp.json()) as { instanceId?: unknown };
		return body.instanceId === handle.instanceId;
	} catch {
		return false;
	}
}
