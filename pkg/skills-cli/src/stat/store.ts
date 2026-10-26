import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath, withFileLock, writeFileAtomic } from "@dg/common/node";
import { type ChecklistModel, emptyModel } from "./model";
import { parseChecklist, serializeChecklist } from "./checklist";

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

/** Reads, mutates, and writes one checklist while holding its lockfile. */
export async function updateChecklist<T extends { model: ChecklistModel }>(
	path: string,
	mutate: (model: ChecklistModel) => T,
): Promise<T> {
	mkdirSync(dirname(path), { recursive: true });
	return withFileLock(path, () => {
		const next = mutate(readChecklist(path));
		writeChecklist(path, next.model);
		return next;
	});
}
