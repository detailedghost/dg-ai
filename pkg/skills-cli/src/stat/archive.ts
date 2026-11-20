import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "@dg/common/node";
import { localDate } from "../spec/shared";
import type { ChecklistItem, ChecklistModel } from "./model";
import { serializeChecklist } from "./checklist";
import { readChecklist, writeChecklist } from "./store";

export interface ArchiveReport {
	kind: "checklist-archive";
	moved: number;
	openChildren: number;
	archive: string;
}

interface Split {
	model: ChecklistModel;
	archived: ChecklistItem[];
	openChildren: number;
}

export function archivePath(checklist: string): string {
	return join(dirname(checklist), "checklist-archive.md");
}

function splitDone(model: ChecklistModel): Split {
	const openChildren = model.done.reduce(
		(sum, item) => sum + item.children.filter((c) => c.status !== "done").length,
		0,
	);
	return { model: { open: model.open, done: [] }, archived: model.done, openChildren };
}

function appendArchive(file: string, items: ChecklistItem[]): void {
	const separator = existsSync(file) && statSync(file).size > 0 ? "\n" : "";
	const body = serializeChecklist({ open: [], done: items });
	appendFileSync(file, `${separator}## Archived ${localDate()}\n\n${body}`);
}

/** Moves every done top-level item and its subtree into the sibling archive file. */
export async function archiveDone(path: string, dryRun: boolean): Promise<ArchiveReport> {
	const archive = archivePath(path);
	const report = (split: Split): ArchiveReport => ({
		kind: "checklist-archive",
		moved: split.archived.length,
		openChildren: split.openChildren,
		archive,
	});
	if (dryRun) return report(splitDone(readChecklist(path)));
	mkdirSync(dirname(path), { recursive: true });
	return withFileLock(path, () => {
		const split = splitDone(readChecklist(path));
		if (split.archived.length === 0) return report(split);
		const archivedBytes = existsSync(archive) ? statSync(archive).size : 0;
		appendArchive(archive, split.archived);
		try {
			writeChecklist(path, split.model);
		} catch (error) {
			try {
				truncateSync(archive, archivedBytes);
			} catch {}
			throw error;
		}
		return report(split);
	});
}
