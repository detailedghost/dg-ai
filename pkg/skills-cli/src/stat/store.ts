import { existsSync, readFileSync } from "node:fs";
import { statePath, writeFileAtomic } from "@dg/common/node";
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
