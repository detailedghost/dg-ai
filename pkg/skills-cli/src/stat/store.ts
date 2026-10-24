import { dlopen, read as readPointer } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	ftruncateSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isAlive, statePath, writeFileAtomic } from "@dg/common/node";
import { type ChecklistModel, emptyModel } from "./model";
import { parseChecklist, serializeChecklist } from "./checklist";

const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 100;
const EMPTY_LOCK_STALE_MS = 2000;
const LOCK_BODY_CAP = 64;
const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;
const EAGAIN_LINUX = 11;
const EAGAIN_DARWIN = 35;

export function checklistPath(cwd?: string): string {
	return statePath("stat", "checklist.md", cwd ? { cwd } : {});
}

export function readChecklist(path: string): ChecklistModel {
	if (!existsSync(path)) return emptyModel();
	return parseChecklist(readFileSync(path, "utf8"));
}

export function writeChecklist(path: string, model: ChecklistModel): void {
	writeFileAtomic(path, serializeChecklist(model));
}

/**
 * A lock body names a pid only when the entire trimmed text is a canonical base-10 integer.
 * `123abc`, whitespace, and a value that does not round-trip through `Number` are not pids.
 */
function lockPid(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) return undefined;
	const pid = Number(trimmed);
	if (!Number.isSafeInteger(pid) || String(pid) !== trimmed) return undefined;
	return pid;
}

/**
 * A pid greater than 1 that is not alive is stale immediately. Any other integer (negative, 0, or 1)
 * does not name a dead process and is never stale. Empty or non-numeric bytes are stale only after
 * the empty-lock grace period, the same window a crash between create and write already uses.
 */
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
	throw new Error(`checklist lock requires flock (${String(last)})`);
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

/**
 * Linux and Darwin mutual exclusion.
 *
 * An exclusive non-blocking `flock` is held on the lock inode from the staleness decision through
 * the critical section. The kernel drops that flock if this process dies, so a dead holder cannot
 * keep it. The lock path is not removed until the critical section has finished, and release
 * unlinks it only when the path still names this inode. A waiter that already opened the inode
 * and then finds `nlink === 0` does not enter. Another process therefore cannot create a second
 * lock in the gap that used to sit between "this body is stale" and `rename`, and cannot delete a
 * live successor that replaced the stale file.
 *
 * The body is still the publication of who holds the lock, judged only while the flock is held:
 * a trimmed pid greater than 1 that is not alive is taken immediately; any other integer is left
 * alone; empty or non-numeric bytes are taken only after the grace period. A file this call just
 * created empty is ours. A live pid is left alone even when that process is not itself using
 * `flock`, so a published live owner is not stolen.
 */
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
		if (wrote !== payload.length) throw new Error(`incomplete checklist lock write to ${lock}`);
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

async function withFlockChecklistLock<T>(lock: string, fn: () => T | Promise<T>): Promise<T> {
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

/**
 * Puts `claim` back at `lock` without replacing a lock created after the rename.
 * `link` fails with EEXIST when the path is already taken. The claim name is always removed.
 */
function restoreClaim(claim: string, lock: string): void {
	try {
		linkSync(claim, lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	rmSync(claim, { force: true });
}

/**
 * Renames the lock aside, then judges the inode that was actually taken. A successor that
 * replaced the stale file (the live lock a winner just created) does not match the body that
 * was stale, so it is linked back and this caller does not keep it. `link` is exclusive, so a
 * lock created while the path was empty is not overwritten.
 *
 * The path is absent between the rename and the restore. On platforms without `flock` a third
 * process can create its own lock in that gap and overlap the owner whose file was moved. Linux
 * and Darwin do not use this path.
 */
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

async function withRenameChecklistLock<T>(lock: string, fn: () => T | Promise<T>): Promise<T> {
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

/** Same exclusive lock the checklist writer uses: one holder inside the critical section, then no lock file left behind. */
async function withChecklistLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(file), { recursive: true });
	const lock = `${file}.lock`;
	if (process.platform === "linux" || process.platform === "darwin") return withFlockChecklistLock(lock, fn);
	return withRenameChecklistLock(lock, fn);
}

/** Reads, mutates, and writes one checklist while holding its lockfile. */
export async function updateChecklist<T extends { model: ChecklistModel }>(
	path: string,
	mutate: (model: ChecklistModel) => T,
): Promise<T> {
	return withChecklistLock(path, () => {
		const next = mutate(readChecklist(path));
		writeChecklist(path, next.model);
		return next;
	});
}
