export const DEFAULT_ARCHIVE_MAX_ROWS = 100;
export const DEFAULT_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WAL_CHECKPOINT_PAGE_THRESHOLD = 1_000;

export type ArchiveRow = {
	id: string;
	archivedAt: number;
};

/**
 * Ids to drop so the archive stays inside both the age cap and the row cap.
 * Expired rows go first. Overflow drops the oldest rows that are still inside the age cap.
 */
export function pruneArchiveIds(
	rows: readonly ArchiveRow[],
	now: number,
	limits: { maxRows: number; ttlMs: number },
): string[] {
	const expired: string[] = [];
	const fresh: ArchiveRow[] = [];
	for (const row of rows) {
		if (now - row.archivedAt >= limits.ttlMs) expired.push(row.id);
		else fresh.push(row);
	}
	fresh.sort((left, right) => right.archivedAt - left.archivedAt);
	const overflow = fresh.slice(limits.maxRows).map((row) => row.id);
	return [...expired, ...overflow];
}

/** A passive checkpoint is worth running once the WAL has at least this many pages. */
export function shouldCheckpointWal(walPages: number, threshold: number): boolean {
	return walPages >= threshold;
}
