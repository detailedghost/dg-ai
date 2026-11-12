import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { assertNotBlocked, type EntryName } from "@dg/common/node/layout";

/** Throws while the legacy source of `entry` has not moved to its per-OS destination. */
export function assertEntryMoved(entry: EntryName): void {
	assertNotBlocked(resolveDgPaths(), entry);
}

/** Returns `path` once `assertEntryMoved` passes, so a write can take its destination through the guard. */
export function guardedDest(entry: EntryName, path: string): string {
	assertEntryMoved(entry);
	return path;
}
