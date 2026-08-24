import { type Dirent, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { readPidFile } from "../server/pidfile";
import type { Logger } from "../server/log";
import type { ChatStore } from "../store";
import { setAssetCleanupHook } from "../utils/asset-cleanup";
import { describeError } from "../utils/errors";
import { getConfiguredAssetDirectory } from "./config";
import { assertFlatSegment, lstatIfExists } from "./safe-path";

const SESSION_DIRECTORY_NAME =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	if (!root) return;
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!SESSION_DIRECTORY_NAME.test(entry.name)) continue;
		pruneSession(paths, store, entry.name);
	}
}

function ownsTheAssetRoot(paths: DgPaths, boundPort: number): boolean {
	const handle = readPidFile(paths);
	return handle === undefined || handle.port === boundPort;
}

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
			logger.error(`startup asset sweep failed: ${describeError(err)}`);
		}
	} else {
		logger.warn(
			"skipping the startup asset sweep: the pid file names another daemon, which may still own the staged directories",
		);
	}

	return setAssetCleanupHook((sessionId) => {
		try {
			pruneSession(paths, store, sessionId);
		} catch (err) {
			logger.error(
				`asset cleanup for session ${sessionId} failed: ${describeError(err)}`,
			);
		}
	});
}
