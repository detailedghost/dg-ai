import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { getConfiguredAssetDirectory } from "../../src/assets/config";
import {
	allocatePort,
	cleanupDgHome,
	closeSession,
	freshDgHome,
	freshTempDir,
	killDaemonByPidFile,
	registerSession,
	spawnServe,
	stageAsset,
	waitForHealth,
	waitForValue,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

const UUID_SHAPED_ORPHAN = "9f2c1b40-6a7d-4e58-9b31-0c5d8e2a71f4";

function stagedSource(bytes: number[]): string {
	const scratch = freshTempDir("dg-asset-cleanup-source");
	const sourcePath = join(scratch, "picture.png");
	writeFileSync(sourcePath, Buffer.from(bytes));
	return sourcePath;
}

describe("session-close cleanup trigger", () => {
	it("removes a session's staged asset directory once it closes, without touching the root it lives in", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		const bootstrap = await registerSession(port);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const root = getConfiguredAssetDirectory(paths);

		const assetId = await stageAsset(
			dgHome,
			port,
			bootstrap.sessionId,
			stagedSource([0x89, 0x50, 0x4e, 0x47]),
		);
		expect(assetId.length).toBeGreaterThan(0);
		const sessionAssetDir = join(root, bootstrap.sessionId);
		expect(existsSync(sessionAssetDir)).toBe(true);

		const sentinel = join(root, "sentinel.txt");
		writeFileSync(sentinel, "must survive every cleanup");

		await closeSession(dgHome, port, bootstrap.sessionId);

		await waitForValue(
			() => (existsSync(sessionAssetDir) ? undefined : true),
			3000,
			"the closed session's asset directory to be removed",
		);
		expect(existsSync(root)).toBe(true);
		expect(existsSync(sentinel)).toBe(true);
	}, 30000);
});

describe("startup orphan-pruning trigger", () => {
	it("sweeps a session directory left over from a prior process life, without touching a session created in the new one", async () => {
		dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const root = getConfiguredAssetDirectory(paths);

		const orphanDir = join(root, UUID_SHAPED_ORPHAN);
		mkdirSync(orphanDir, { recursive: true });
		writeFileSync(join(orphanDir, "leftover.bin"), "orphaned bytes");

		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		const bootstrap = await registerSession(port);

		await waitForValue(
			() => (existsSync(orphanDir) ? undefined : true),
			3000,
			"the orphaned pre-existing asset directory to be swept at startup",
		);

		await stageAsset(
			dgHome,
			port,
			bootstrap.sessionId,
			stagedSource([1, 2, 3]),
		);
		expect(existsSync(join(root, bootstrap.sessionId))).toBe(true);
	}, 30000);

	it("skips the sweep entirely when the pid file names a daemon on another port, which a bind-race loser would be", async () => {
		dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const root = getConfiguredAssetDirectory(paths);
		const orphanDir = join(root, UUID_SHAPED_ORPHAN);
		mkdirSync(orphanDir, { recursive: true });

		mkdirSync(paths.daemonDir, { recursive: true });
		writeFileSync(
			paths.pidPath,
			JSON.stringify({
				pid: 1,
				port: 1,
				instanceId: "00000000-0000-4000-8000-000000000000",
				versions: { package: "1.0.0", protocol: CHAT_PROTOCOL_VERSION },
			}),
		);

		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);

		expect(existsSync(orphanDir)).toBe(true);
	}, 30000);

	it("leaves the configured root, a stray file in it, and any non-session directory untouched", async () => {
		dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const root = getConfiguredAssetDirectory(paths);
		mkdirSync(root, { recursive: true });

		const sentinel = join(root, "keep-me.txt");
		writeFileSync(sentinel, "not a session directory");
		const notASession = join(root, "definitely-not-a-uuid");
		mkdirSync(notASession);
		writeFileSync(join(notASession, "inner.bin"), "still here");
		const orphanDir = join(root, UUID_SHAPED_ORPHAN);
		mkdirSync(orphanDir);

		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);

		await waitForValue(
			() => (existsSync(orphanDir) ? undefined : true),
			3000,
			"the uuid-shaped orphan directory to be swept",
		);
		expect(existsSync(root)).toBe(true);
		expect(existsSync(sentinel)).toBe(true);
		expect(existsSync(join(notASession, "inner.bin"))).toBe(true);
	}, 30000);
});
