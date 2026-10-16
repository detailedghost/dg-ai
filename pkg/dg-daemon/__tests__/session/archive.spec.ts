import { describe, expect, it } from "bun:test";
import {
	DEFAULT_ARCHIVE_MAX_ROWS,
	DEFAULT_ARCHIVE_TTL_MS,
	pruneArchiveIds,
	shouldCheckpointWal,
	WAL_CHECKPOINT_PAGE_THRESHOLD,
} from "../../src/session/archive";

describe("pruneArchiveIds", () => {
	it("uses a 100 row cap and a seven day age cap", () => {
		expect(DEFAULT_ARCHIVE_MAX_ROWS).toBe(100);
		expect(DEFAULT_ARCHIVE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
		expect(WAL_CHECKPOINT_PAGE_THRESHOLD).toBe(1_000);
	});

	it("drops rows once they are exactly ttl old, and keeps one millisecond inside", () => {
		const rows = [{ id: "old", archivedAt: 500 }];
		expect(pruneArchiveIds(rows, 1_499, { maxRows: 10, ttlMs: 1_000 })).toEqual([]);
		expect(pruneArchiveIds(rows, 1_500, { maxRows: 10, ttlMs: 1_000 })).toEqual([
			"old",
		]);
	});

	it("drops the oldest rows once the fresh archive is over the row cap", () => {
		const rows = [
			{ id: "older", archivedAt: 10 },
			{ id: "newer", archivedAt: 20 },
		];
		expect(pruneArchiveIds(rows, 20, { maxRows: 1, ttlMs: 1_000 })).toEqual([
			"older",
		]);
		expect(pruneArchiveIds(rows, 20, { maxRows: 2, ttlMs: 1_000 })).toEqual([]);
	});

	it("drops every fresh row when the cap is zero", () => {
		expect(
			pruneArchiveIds([{ id: "only", archivedAt: 5 }], 5, {
				maxRows: 0,
				ttlMs: 10,
			}),
		).toEqual(["only"]);
	});
});

describe("shouldCheckpointWal", () => {
	it("checkpoints once the WAL reaches the page threshold", () => {
		expect(shouldCheckpointWal(999, 1_000)).toBe(false);
		expect(shouldCheckpointWal(1_000, 1_000)).toBe(true);
	});
});
