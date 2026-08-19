/**
 * Two DISTINCT cleanup triggers (Engineering, explicit): session-close
 * removes ONE session's staged assets via the already-wired
 * setAssetCleanupHook/triggerAssetCleanup seam (utils/asset-cleanup.ts,
 * called from registry.close()); a fresh daemon's startup sweep removes
 * whatever was left on disk from a PRIOR process life, since SessionRegistry
 * is in-memory only and no session can survive a restart to reclaim it.
 *
 * [SPEC] ASSUMED design: "startup prunes orphans" is read here as "every
 * asset directory that predates this process's (empty, on cold start)
 * registry is an orphan" — see deferrals for the alternative (persisting
 * session state) and why it was rejected.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { runCli } from "../commands/cli-wire";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	waitForHealth,
	waitForValue,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

describe("session-close cleanup trigger", () => {
	it("removes a session's staged asset directory once it closes, leaving no trace", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const result = await runStart(dgHome, port);
		await waitForHealth(port);
		const bootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(result.stdout)),
		);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });

		const scratch = freshDgHome();
		const sourcePath = join(scratch, "picture.png");
		writeFileSync(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const staged = await runCli(dgHome, port, [
			"stage",
			sourcePath,
			"--session",
			bootstrap.sessionId,
		]);
		expect(staged.exitCode).toBe(0);
		const sessionAssetDir = join(paths.assetsDir, bootstrap.sessionId);
		expect(existsSync(sessionAssetDir)).toBe(true);

		const closed = await runCli(dgHome, port, [
			"close",
			"--session",
			bootstrap.sessionId,
		]);
		expect(closed.exitCode).toBe(0);

		await waitForValue(
			() => (existsSync(sessionAssetDir) ? undefined : true),
			3000,
			"the closed session's asset directory to be removed",
		);
	}, 30000);
});

describe("startup orphan-pruning trigger", () => {
	it("removes an asset directory left over from a prior process life, without touching a session created in the new one", async () => {
		dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });

		// Simulate a leftover from a previous daemon life — no session for this
		// id will ever exist in the fresh registry this test's daemon starts.
		const orphanDir = join(paths.assetsDir, "stale-session-from-last-run");
		mkdirSync(orphanDir, { recursive: true });
		writeFileSync(join(orphanDir, "leftover.bin"), "orphaned bytes");

		const port = allocatePort();
		const result = await runStart(dgHome, port);
		await waitForHealth(port);
		const bootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(result.stdout)),
		);

		await waitForValue(
			() => (existsSync(orphanDir) ? undefined : true),
			3000,
			"the orphaned pre-existing asset directory to be swept at startup",
		);

		// The startup sweep ran before this session existed — its own,
		// later-staged assets must survive it, proving the two triggers are
		// separate rather than one sweep re-running destructively.
		const scratch = freshDgHome();
		const sourcePath = join(scratch, "picture.png");
		writeFileSync(sourcePath, Buffer.from([1, 2, 3]));
		await runCli(dgHome, port, [
			"stage",
			sourcePath,
			"--session",
			bootstrap.sessionId,
		]);
		const liveSessionAssetDir = join(paths.assetsDir, bootstrap.sessionId);
		expect(existsSync(liveSessionAssetDir)).toBe(true);
	}, 30000);
});
