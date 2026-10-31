import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../privacy/files";
import type { DraftRecord, SmsProviderId } from "../types";

export function draftsDir(home: string): string {
	return join(home, "ssms", "drafts");
}

export function draftPath(home: string, id: string): string {
	return join(draftsDir(home), `${id}.json`);
}

export function writeDraft(home: string, draft: DraftRecord): void {
	writePrivateFile(draftsDir(home), draftPath(home, draft.id), `${JSON.stringify(draft)}\n`);
}

export function readDraft(home: string, id: string): DraftRecord {
	let text: string;
	try {
		text = readFileSync(draftPath(home, id), "utf8");
	} catch {
		throw new Error(`draft not found: ${id}`);
	}
	const draft = JSON.parse(text) as DraftRecord;
	if (draft.id !== id) throw new Error(`draft not found: ${id}`);
	return draft;
}

export function assertDraftProvider(draft: DraftRecord, provider: SmsProviderId): void {
	if (draft.provider !== provider) {
		throw new Error(`draft ${draft.id} belongs to ${draft.provider}`);
	}
	if (draft.status !== "pending") throw new Error(`draft ${draft.id} is ${draft.status}`);
}
