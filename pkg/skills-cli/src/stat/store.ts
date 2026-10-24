import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAlive, statePath, writeFileAtomic } from "@dg/common/node";
import { type ChecklistModel, emptyModel } from "./model";
import { parseChecklist, serializeChecklist } from "./checklist";

const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 100;

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

function lockOwnerGone(lock: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
		return Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid);
	} catch {
		return false;
	}
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
			if (lockOwnerGone(lock)) rmSync(lock, { force: true });
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
