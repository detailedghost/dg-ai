/** Staged-asset cleanup: the session-close hook plus the startup orphan sweep. */
import { type Dirent, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { readLockfile } from "../server/lockfile";
import type { Logger } from "../server/log";
import type { ChatStore } from "../store";
import { setAssetCleanupHook } from "../utils/asset-cleanup";
import { getConfiguredAssetDirectory } from "./config";
import { assertFlatSegment, lstatIfExists } from "./safe-path";

const SESSION_DIRECTORY_NAME =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The root the daemon may delete inside, or undefined when it is not a real owned directory. */
function assetRootIfOwned(paths: DgPaths): string | undefined {
	const root = getConfiguredAssetDirectory(paths);
	const info = lstatIfExists(root);
	if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined;
	return root;
}

function removeSessionAssetDirectory(root: string, sessionId: string): void {
	assertFlatSegment(sessionId);
	const target = join(root, sessionId);
	if (lstatIfExists(target)?.isDirectory() !== true) return;
	rmSync(target, { recursive: true, force: true });
}

/** Rows first: a failed directory removal must never leave servable rows pointing at bytes that are already gone. */
function pruneSession(
	paths: DgPaths,
	store: ChatStore,
	sessionId: string,
): void {
	store.pruneSessionAssets(sessionId);
	const root = assetRootIfOwned(paths);
	if (root) removeSessionAssetDirectory(root, sessionId);
}

function sweepOrphanedAssetDirectories(paths: DgPaths, store: ChatStore): void {
	const root = assetRootIfOwned(paths);
	if (!root) return; // no root, or one we did not create — never sweep through it
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return; // nothing staged under this root yet
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!SESSION_DIRECTORY_NAME.test(entry.name)) continue;
		pruneSession(paths, store, entry.name);
	}
}

/** False for a bind-race loser, so it never sweeps the winner's live sessions. */
function ownsTheAssetRoot(paths: DgPaths, boundPort: number): boolean {
	const handle = readLockfile(paths);
	return handle === undefined || handle.port === boundPort;
}

/** Call once at daemon startup after the bind; returns the session-close hook's disposer. */
export function installAssetLifecycle(
	paths: DgPaths,
	store: ChatStore,
	logger: Logger,
	boundPort: number,
): () => void {
	if (ownsTheAssetRoot(paths, boundPort)) {
		try {
			sweepOrphanedAssetDirectories(paths, store);
		} catch (err) {
			logger.error(
				`startup asset sweep failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else {
		logger.warn(
			"skipping the startup asset sweep: the lockfile names another daemon, which may still own the staged directories",
		);
	}

	return setAssetCleanupHook((sessionId) => {
		try {
			pruneSession(paths, store, sessionId);
		} catch (err) {
			logger.error(
				`asset cleanup for session ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});
}
