import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "@dg/common/node";

const LOCK_TRIES = 600;
const LOCK_WAIT_MS = 100;
const STALE_MS = 15 * 60_000;
const GUARD_STALE_MS = 5000;

export type InstallLockOptions = {
	tries?: number;
	waitMs?: number;
	staleMs?: number;
	onStaleObserved?: () => void;
};

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function ownerPid(body: string): number | undefined {
	const pid = Number(body.split(":")[0]);
	return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

function isStale(body: string, mtimeMs: number, staleMs: number): boolean {
	const pid = ownerPid(body);
	return Date.now() - mtimeMs > staleMs || (pid !== undefined && !isAlive(pid));
}

function tryCreate(lock: string, token: string): boolean {
	try {
		const fd = openSync(lock, "wx");
		try {
			writeSync(fd, token);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		if (errno(error) === "EEXIST") return false;
		throw error;
	}
}

function tryGuard(guard: string, token: string): boolean {
	if (tryCreate(guard, token)) return true;
	try {
		if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmSync(guard, { force: true });
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
	}
	return tryCreate(guard, token);
}

function reclaimIfStale(lock: string, staleMs: number, token: string, onStaleObserved?: () => void): boolean {
	const guard = `${lock}.reclaim`;
	if (!tryGuard(guard, token)) return false;
	try {
		onStaleObserved?.();
		if (isStale(readFileSync(lock, "utf8"), statSync(lock).mtimeMs, staleMs)) rmSync(lock, { force: true });
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
	} finally {
		release(guard, token);
	}
	return true;
}

function release(lock: string, token: string): void {
	try {
		if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
	}
}

/**
 * Runs `fn` while holding `<root>/.install.lock`. An owner that is dead, or a lock older than
 * the stale age, is taken over so a crashed install never blocks the next one. A stale lock is
 * removed only under a reclaim guard and only after it is re-read, so a live replacement survives.
 */
export async function withInstallLock<T>(
	root: string,
	fn: () => T | Promise<T>,
	{ tries = LOCK_TRIES, waitMs = LOCK_WAIT_MS, staleMs = STALE_MS, onStaleObserved }: InstallLockOptions = {},
): Promise<T> {
	mkdirSync(root, { recursive: true });
	const lock = join(root, ".install.lock");
	const token = `${process.pid}:${randomUUID()}`;
	for (let attempt = 0; attempt < tries; attempt++) {
		if (tryCreate(lock, token)) {
			try {
				return await fn();
			} finally {
				release(lock, token);
			}
		}
		try {
			if (isStale(readFileSync(lock, "utf8"), statSync(lock).mtimeMs, staleMs)) {
				if (reclaimIfStale(lock, staleMs, token, onStaleObserved)) continue;
			}
		} catch (error) {
			if (errno(error) === "ENOENT") continue;
			throw error;
		}
		await Bun.sleep(waitMs);
	}
	throw new Error(`${lock} is held by another dg install; remove it if none is running`);
}
