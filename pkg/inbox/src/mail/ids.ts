import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFileIfExists, writeJsonFile } from "../utils/json";

export type MailIdEntry = {
	hash: string;
	id: string;
};

type MailIdsFile = {
	ids: MailIdEntry[];
};

const MAX_REMEMBERED_IDS = 5000;
const IDS_FILE_MODE = 0o600;

function idsFilePath(workspaceDir: string): string {
	return join(workspaceDir, "mail", "ids.json");
}

async function loadIds(workspaceDir: string): Promise<MailIdEntry[]> {
	const file = await readJsonFileIfExists<MailIdsFile>(idsFilePath(workspaceDir));
	return file?.ids ?? [];
}

/** Remembers hashed-id to private-provider-id pairs, oldest entries first out past the 5000 cap. */
export async function rememberIds(
	workspaceDir: string,
	entries: MailIdEntry[],
): Promise<void> {
	const byHash = new Map(
		(await loadIds(workspaceDir)).map((entry) => [entry.hash, entry]),
	);
	for (const entry of entries) byHash.set(entry.hash, entry);
	const merged = [...byHash.values()];
	const trimmed = merged.slice(Math.max(0, merged.length - MAX_REMEMBERED_IDS));
	const path = idsFilePath(workspaceDir);
	await writeJsonFile(path, { ids: trimmed } satisfies MailIdsFile);
	await chmod(path, IDS_FILE_MODE);
}

/** Resolves a model-facing hashed id back to its private provider id, or undefined when never remembered. */
export async function resolveId(
	workspaceDir: string,
	hash: string,
): Promise<string | undefined> {
	return (await loadIds(workspaceDir)).find((entry) => entry.hash === hash)?.id;
}
