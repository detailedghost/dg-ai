import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "@dg/common/node";

const LOCK_TRIES = 600;
const LOCK_WAIT_MS = 100;
const STALE_MS = 15 * 60_000;

export type InstallLockOptions = { tries?: number; waitMs?: number; staleMs?: number };

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

function reclaimIfStale(lock: string, staleMs: number): void {
	const aside = `${lock}.${process.pid}.${randomUUID()}.stale`;
	try {
		renameSync(lock, aside);
	} catch (error) {
		if (errno(error) === "ENOENT") return;
		throw error;
	}
	try {
		if (isStale(readFileSync(aside, "utf8"), statSync(aside).mtimeMs, staleMs)) return;
		try {
			linkSync(aside, lock);
		} catch (error) {
			if (errno(error) !== "EEXIST") throw error;
		}
	} finally {
		rmSync(aside, { force: true });
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
 * Runs `fn` while holding `<root>/.install.lock`. An owner that is dead, or a lock older than
 * the stale age, is taken over so a crashed install never blocks the next one.
 */
export async function withInstallLock<T>(
	root: string,
	fn: () => T | Promise<T>,
	{ tries = LOCK_TRIES, waitMs = LOCK_WAIT_MS, staleMs = STALE_MS }: InstallLockOptions = {},
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
				reclaimIfStale(lock, staleMs);
				continue;
			}
		} catch (error) {
			if (errno(error) === "ENOENT") continue;
			throw error;
		}
		await Bun.sleep(waitMs);
	}
	throw new Error(`${lock} is held by another dg install; remove it if none is running`);
}
