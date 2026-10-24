import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAlive, statePath, writeFileAtomic } from "@dg/common/node";
import { type ChecklistModel, emptyModel } from "./model";
import { parseChecklist, serializeChecklist } from "./checklist";

const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 100;
const EMPTY_LOCK_STALE_MS = 2000;

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
 * A lock naming a dead pid is stale. An empty lock (a crash between creating it and writing its pid) is stale
 * once it's old enough that a legitimate writer would already have named itself. A lock already gone needs no
 * reclaiming. A lock this process can't read for any other reason is left alone, since it might be live and
 * merely unreadable to this process.
 */
function isLockStale(lock: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(lock, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	if (raw !== "") {
		const pid = Number.parseInt(raw, 10);
		return Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid);
	}
	try {
		return Date.now() - statSync(lock).mtimeMs > EMPTY_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

/**
 * Claims a lock this process judged stale by renaming it aside first. The rename is atomic, so of several
 * contenders that all judged the same lock stale, only one wins it; a loser gets ENOENT and backs off rather
 * than deleting whatever the winner just created in its place — closing the check-then-remove race where two
 * waiters could otherwise both decide "stale" and the second one deletes the first's fresh, live lock.
 */
function reclaimStaleLock(lock: string): void {
	const claim = `${lock}.${process.pid}.${randomUUID()}.stale`;
	try {
		renameSync(lock, claim);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	rmSync(claim, { force: true });
}

/** Same exclusive lockfile the checkpoint writer uses: create with `wx`, steal a dead owner's lock, wait a bounded time. */
async function withChecklistLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(file), { recursive: true });
	const lock = `${file}.lock`;
	let held = false;
	for (let i = 0; i < LOCK_TRIES && !held; i++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			held = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (isLockStale(lock)) reclaimStaleLock(lock);
			else await Bun.sleep(LOCK_WAIT_MS);
		}
	}
	if (!held)
		throw new Error(`${lock} is held; remove it if no other session is writing`);
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
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
