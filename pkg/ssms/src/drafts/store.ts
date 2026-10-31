import { readFileSync, renameSync } from "node:fs";
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

function claimedPath(home: string, id: string): string {
	return join(draftsDir(home), `${id}.sending`);
}

export function claimDraft(home: string, id: string, provider: SmsProviderId): DraftRecord {
	const src = draftPath(home, id);
	const dest = claimedPath(home, id);
	try {
		renameSync(src, dest);
	} catch {
		throw new Error(`draft ${id} is already being sent`);
	}
	const draft = JSON.parse(readFileSync(dest, "utf8")) as DraftRecord;
	if (draft.id !== id || draft.provider !== provider || draft.status !== "pending") {
		writePrivateFile(draftsDir(home), dest, `${JSON.stringify({ ...draft, status: "uncertain" })}\n`);
		throw new Error(`draft ${id} is uncertain`);
	}
	return draft;
}

export function releaseDraft(home: string, draft: DraftRecord): void {
	const pending: DraftRecord = { ...draft, status: "pending" };
	const src = claimedPath(home, draft.id);
	writePrivateFile(draftsDir(home), src, `${JSON.stringify(pending)}\n`);
	renameSync(src, draftPath(home, draft.id));
}

export function finishDraft(
	home: string,
	draft: DraftRecord,
	status: "sent" | "uncertain",
): void {
	writePrivateFile(
		draftsDir(home),
		claimedPath(home, draft.id),
		`${JSON.stringify({ ...draft, status })}\n`,
	);
}

export function assertDraftProvider(draft: DraftRecord, provider: SmsProviderId): void {
	if (draft.provider !== provider) {
		throw new Error(`draft ${draft.id} belongs to ${draft.provider}`);
	}
	if (draft.status !== "pending") throw new Error(`draft ${draft.id} is ${draft.status}`);
}
