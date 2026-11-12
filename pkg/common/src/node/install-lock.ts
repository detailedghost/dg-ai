import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, readProcStart } from "./plugin-cache";

const LOCK_TRIES = 600;
const LOCK_WAIT_MS = 100;
const EMPTY_GRACE_MS = 2000;
const GUARD_STALE_MS = 5000;

export type InstallLockOptions = {
	tries?: number;
	waitMs?: number;
	onStaleObserved?: () => void;
};

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

type Owner = { pid: number; procStart?: string };

function parseOwner(body: string): Owner | undefined {
	const [pidText, procStart] = body.split(":");
	const pid = Number(pidText);
	return Number.isSafeInteger(pid) && pid > 1 ? { pid, procStart: procStart || undefined } : undefined;
}

function isStale(body: string, mtimeMs: number): boolean {
	const owner = parseOwner(body);
	if (!owner) return Date.now() - mtimeMs > EMPTY_GRACE_MS;
	return !pidAlive(owner.pid, owner.procStart);
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

function reclaimIfStale(lock: string, token: string, onStaleObserved?: () => void): boolean {
	const guard = `${lock}.reclaim`;
	if (!tryGuard(guard, token)) return false;
	try {
		onStaleObserved?.();
		if (isStale(readFileSync(lock, "utf8"), statSync(lock).mtimeMs)) rmSync(lock, { force: true });
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
	} finally {
		release(guard, token);
	}
	return true;
}

function readOwnerBody(lock: string): string {
	try {
		return readFileSync(lock, "utf8");
	} catch {
		return "";
	}
}

function release(lock: string, token: string): void {
	try {
		if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
	}
}

/**
 * Runs `fn` while holding `<root>/.install.lock`. A lock whose owner is alive is held however old
 * it is. Only a dead owner, or a pid reused by a process with another start time, makes it stale.
 * A stale lock is removed only under a reclaim guard and only after it is re-read, so a live
 * replacement survives.
 */
export async function withInstallLock<T>(
	root: string,
	fn: () => T | Promise<T>,
	{ tries = LOCK_TRIES, waitMs = LOCK_WAIT_MS, onStaleObserved }: InstallLockOptions = {},
): Promise<T> {
	mkdirSync(root, { recursive: true });
	const lock = join(root, ".install.lock");
	const token = `${process.pid}:${readProcStart(process.pid) ?? ""}:${randomUUID()}`;
	for (let attempt = 0; attempt < tries; attempt++) {
		if (tryCreate(lock, token)) {
			try {
				return await fn();
			} finally {
				release(lock, token);
			}
		}
		try {
			if (isStale(readFileSync(lock, "utf8"), statSync(lock).mtimeMs)) {
				if (reclaimIfStale(lock, token, onStaleObserved)) continue;
			}
		} catch (error) {
			if (errno(error) === "ENOENT") continue;
			throw error;
		}
		await Bun.sleep(waitMs);
	}
	const owner = parseOwner(readOwnerBody(lock));
	throw new Error(
		`${lock} is held${owner ? ` by pid ${owner.pid}` : ""}; wait for that install to finish or remove the file if it is not running`,
	);
}
