import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { ensurePrivateDir } from "@dg/common/node";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_HEARTBEAT_MS = LOCK_STALE_MS / 3;

let lockBreaks = 0;

function holderAlive(content: string): boolean | undefined {
	try {
		const holder: unknown = JSON.parse(content);
		if (typeof holder !== "object" || holder === null) return undefined;
		const { pid, host } = holder as { pid?: unknown; host?: unknown };
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || host !== hostname()) return undefined;
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code !== "ESRCH";
		}
	} catch {
		return undefined;
	}
}

function lockStale(path: string): boolean {
	try {
		const alive = holderAlive(readFileSync(path, "utf8"));
		if (alive !== undefined) return !alive;
		return Date.now() - statSync(path).mtimeMs >= LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function breakStaleLock(path: string): void {
	const aside = `${path}.${process.pid}.${(lockBreaks += 1)}`;
	try {
		renameSync(path, aside);
	} catch {
		return;
	}
	if (!lockStale(aside)) {
		try {
			writeFileSync(path, readFileSync(aside), { flag: "wx", mode: 0o600 });
		} catch {}
	}
	rmSync(aside, { force: true });
}

/** Takes the lock file once; returns its release, or undefined while another process holds it. */
export function tryFileLock(root: string, name: string): (() => void) | undefined {
	ensurePrivateDir(root);
	const path = join(root, name);
	const token = JSON.stringify({ pid: process.pid, host: hostname(), id: randomBytes(8).toString("hex") });
	try {
		writeFileSync(path, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		if (lockStale(path)) breakStaleLock(path);
		return undefined;
	}
	return () => {
		try {
			if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
		} catch {}
	};
}

/** Runs `work` while this process holds `name` in `root`, so only one process runs it at a time. */
export async function withFileLock<T>(root: string, name: string, busyMessage: string, work: () => Promise<T>): Promise<T> {
	const giveUpAt = Date.now() + 2 * LOCK_STALE_MS;
	for (;;) {
		const release = tryFileLock(root, name);
		if (release) {
			const beat = setInterval(() => {
				try {
					const now = new Date();
					utimesSync(join(root, name), now, now);
				} catch {}
			}, LOCK_HEARTBEAT_MS);
			beat.unref();
			try {
				return await work();
			} finally {
				clearInterval(beat);
				release();
			}
		}
		if (Date.now() >= giveUpAt) throw new DgCliError(busyMessage);
		await Bun.sleep(LOCK_WAIT_MS);
	}
}

/** Blocking form of `withFileLock` for work that must stay synchronous, such as a database transaction. */
export function withFileLockSync<T>(root: string, name: string, busyMessage: string, work: () => T): T {
	const giveUpAt = Date.now() + 2 * LOCK_STALE_MS;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		const release = tryFileLock(root, name);
		if (release) {
			try {
				return work();
			} finally {
				release();
			}
		}
		if (Date.now() >= giveUpAt) throw new DgCliError(busyMessage);
		Atomics.wait(pause, 0, 0, LOCK_WAIT_MS);
	}
}
