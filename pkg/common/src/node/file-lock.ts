import { dlopen, read as readPointer } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	ftruncateSync,
	linkSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { isAlive } from "./process";

const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 100;
const EMPTY_LOCK_STALE_MS = 2000;
const LOCK_BODY_CAP = 64;
const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;
const EAGAIN_LINUX = 11;
const EAGAIN_DARWIN = 35;

/** Parses a lock body as a pid only when the entire trimmed text is a canonical base-10 integer. */
function lockPid(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) return undefined;
	const pid = Number(trimmed);
	if (!Number.isSafeInteger(pid) || String(pid) !== trimmed) return undefined;
	return pid;
}

/** A dead pid greater than 1 is stale immediately; empty or non-numeric bytes are stale only after the grace period. */
function contentIsStale(raw: string, mtimeMs: number, now = Date.now()): boolean {
	const pid = lockPid(raw);
	if (pid === undefined) return now - mtimeMs > EMPTY_LOCK_STALE_MS;
	if (pid <= 1) return false;
	return !isAlive(pid);
}

function readCapped(fd: number): string {
	const buf = Buffer.alloc(LOCK_BODY_CAP);
	const n = readSync(fd, buf, 0, buf.length, 0);
	return buf.subarray(0, n).toString("utf8");
}

function lockHeldError(lock: string): Error {
	return new Error(`${lock} is held; remove it if no other session is writing`);
}

type Advisory = {
	tryExclusive(fd: number): boolean;
};

let advisoryCache: Advisory | undefined;

function errnoValue(pointer: bigint | number | null): number {
	if (pointer === null) throw new Error("flock errno pointer was null");
	return readPointer.i32(pointer);
}

function bindFlock(
	flock: (fd: number, operation: number) => number,
	errno: () => bigint | number | null,
	again: number,
): Advisory {
	return {
		tryExclusive(fd: number): boolean {
			for (let i = 0; i < 16; i++) {
				if (flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
				const err = errnoValue(errno());
				if (err === EINTR) continue;
				if (err === again) return false;
				throw new Error(`flock(LOCK_EX|LOCK_NB) failed with errno ${err}`);
			}
			return false;
		},
	};
}

function loadLinux(): Advisory {
	const names = ["libc.so.6", "libc.so"];
	let last: unknown;
	for (const name of names) {
		try {
			const lib = dlopen(name, {
				flock: { args: ["i32", "i32"], returns: "i32" },
				__errno_location: { args: [], returns: "ptr" },
			});
			return bindFlock(
				(fd, operation) => lib.symbols.flock(fd, operation),
				() => lib.symbols.__errno_location(),
				EAGAIN_LINUX,
			);
		} catch (error) {
			last = error;
		}
	}
	throw new Error(`file lock requires flock (${String(last)})`);
}

function loadDarwin(): Advisory {
	const lib = dlopen("libSystem.B.dylib", {
		flock: { args: ["i32", "i32"], returns: "i32" },
		__error: { args: [], returns: "ptr" },
	});
	return bindFlock(
		(fd, operation) => lib.symbols.flock(fd, operation),
		() => lib.symbols.__error(),
		EAGAIN_DARWIN,
	);
}

function loadAdvisory(): Advisory {
	if (advisoryCache) return advisoryCache;
	advisoryCache = process.platform === "darwin" ? loadDarwin() : loadLinux();
	return advisoryCache;
}

/** Linux and Darwin mutual exclusion: holds an exclusive non-blocking `flock` on the lock inode, which the kernel drops if this process dies. */
function claimWithFlock(lock: string, advisory: Advisory): "busy" | "retry" | { fd: number } {
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(lock, "wx+");
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		try {
			fd = openSync(lock, "r+");
		} catch (openError) {
			if ((openError as NodeJS.ErrnoException).code === "ENOENT") return "retry";
			throw openError;
		}
	}
	try {
		if (!advisory.tryExclusive(fd)) return "busy";
		const st = fstatSync(fd, { bigint: true });
		if (st.nlink === 0n) return "retry";
		const raw = readCapped(fd);
		const ownFreshCreate = created && raw === "";
		if (!ownFreshCreate && !contentIsStale(raw, Number(st.mtimeMs))) return "busy";
		const payload = Buffer.from(String(process.pid));
		ftruncateSync(fd, 0);
		const wrote = writeSync(fd, payload, 0, payload.length, 0);
		if (wrote !== payload.length) throw new Error(`incomplete lock write to ${lock}`);
		const held = fd;
		fd = undefined;
		return { fd: held };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function releaseFlock(fd: number, lock: string): void {
	try {
		const held = fstatSync(fd, { bigint: true });
		if (held.nlink !== 0n) {
			try {
				const atPath = statSync(lock, { bigint: true });
				if (atPath.dev === held.dev && atPath.ino === held.ino) unlinkSync(lock);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} finally {
		closeSync(fd);
	}
}

async function withFlockLock<T>(lock: string, fn: () => T | Promise<T>): Promise<T> {
	const advisory = loadAdvisory();
	let spins = 0;
	for (let attempt = 0; attempt < LOCK_TRIES; ) {
		const claimed = claimWithFlock(lock, advisory);
		if (typeof claimed === "object") {
			try {
				return await fn();
			} finally {
				releaseFlock(claimed.fd, lock);
			}
		}
		if (claimed === "retry") {
			if (++spins > LOCK_TRIES) break;
			continue;
		}
		spins = 0;
		attempt++;
		await Bun.sleep(LOCK_WAIT_MS);
	}
	throw lockHeldError(lock);
}

function readLockBody(lock: string): string {
	const fd = openSync(lock, "r");
	try {
		return readCapped(fd);
	} finally {
		closeSync(fd);
	}
}

function inspectLock(lock: string): { raw: string; mtimeMs: number } | "missing" | "unreadable" {
	try {
		return { raw: readLockBody(lock), mtimeMs: statSync(lock).mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		return "unreadable";
	}
}

/** Puts `claim` back at `lock` without replacing a lock a winner created after the rename. */
function restoreClaim(claim: string, lock: string): void {
	try {
		linkSync(claim, lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	rmSync(claim, { force: true });
}

/** Renames the lock aside, then judges the inode that was actually taken, restoring it if a winner's lock replaced the stale one. */
function reclaimStaleLock(lock: string, observedRaw: string): boolean {
	const claim = `${lock}.${process.pid}.${randomUUID()}.stale`;
	try {
		renameSync(lock, claim);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	let raw: string;
	let mtimeMs: number;
	try {
		raw = readLockBody(claim);
		mtimeMs = statSync(claim).mtimeMs;
	} catch {
		rmSync(claim, { force: true });
		return false;
	}
	if (raw !== observedRaw || !contentIsStale(raw, mtimeMs)) {
		restoreClaim(claim, lock);
		return false;
	}
	rmSync(claim, { force: true });
	return true;
}

function releaseRenameLock(lock: string): void {
	const mine = String(process.pid);
	let raw: string;
	try {
		raw = readLockBody(lock);
	} catch {
		return;
	}
	if (raw !== mine) return;
	const claim = `${lock}.${process.pid}.${randomUUID()}.release`;
	try {
		renameSync(lock, claim);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let claimed: string;
	try {
		claimed = readLockBody(claim);
	} catch {
		restoreClaim(claim, lock);
		return;
	}
	if (claimed !== mine) {
		restoreClaim(claim, lock);
		return;
	}
	rmSync(claim, { force: true });
}

async function withRenameLock<T>(lock: string, fn: () => T | Promise<T>): Promise<T> {
	for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const inspected = inspectLock(lock);
			if (inspected === "missing") continue;
			if (inspected === "unreadable" || !contentIsStale(inspected.raw, inspected.mtimeMs)) {
				await Bun.sleep(LOCK_WAIT_MS);
				continue;
			}
			reclaimStaleLock(lock, inspected.raw);
			continue;
		}
		try {
			return await fn();
		} finally {
			releaseRenameLock(lock);
		}
	}
	throw lockHeldError(lock);
}

/** Runs `fn` while holding `${file}.lock` exclusively, across processes, with no lock file left behind. */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
	const lock = `${file}.lock`;
	if (process.platform === "linux" || process.platform === "darwin") return withFlockLock(lock, fn);
	return withRenameLock(lock, fn);
}
