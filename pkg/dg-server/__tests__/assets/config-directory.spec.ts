/**
 * Daemon-authoritative asset-directory config: Code Structure's "Daemon
 * config transport" decision — read/write over AUTHENTICATED WebSocket
 * config-get/config-set frames, validated then persisted to the daemon's
 * OWN config.json (server/config-store.ts, already built for exactly this).
 *
 * [SPEC] ASSUMED: neither the reply frame shape nor the config module are
 * named by the plan. `config-result` (outbound-only, `{key, value?, error?}`)
 * is modeled as a structural carve-out BEFORE validateChatFrame — mirroring
 * slice 7's cli-recv-result — specifically so this pass touches no file in
 * pkg/common (no edit access granted there for this slice). See deferrals.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	ASSET_DIRECTORY_CONFIG_KEY,
	getConfiguredAssetDirectory,
	validateAssetDirectory,
} from "../../src/assets/config";
import { readConfig } from "../../src/server/config-store";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	connectCli,
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

describe("validateAssetDirectory", () => {
	it("accepts an existing writable directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-asset-dir-ok-"));
		expect(validateAssetDirectory(dir)).toEqual({ ok: true, value: dir });
	});

	it("rejects a path that cannot be a directory at all, naming the reason — portable even under root", () => {
		const scratch = mkdtempSync(join(tmpdir(), "dg-asset-dir-bad-"));
		const notADirectory = join(scratch, "this-is-a-file");
		writeFileSync(notADirectory, "not a directory");
		const impossiblePath = join(notADirectory, "subdir");

		const result = validateAssetDirectory(impossiblePath);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});
});

describe("getConfiguredAssetDirectory default fallback", () => {
	it("falls back to resolveDgPaths' own assetsDir when nothing has been persisted yet — per-OS resolution stays slice 1's job", () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			expect(getConfiguredAssetDirectory(paths)).toBe(paths.assetsDir);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

async function bootSession() {
	dgHome = freshDgHome();
	const port = allocatePort();
	const result = await runStart(dgHome, port);
	await waitForHealth(port);
	const bootstrap = validateSessionBootstrap(
		decodeChatMarker(extractUrl(result.stdout)),
	);
	return { dgHome, port, bootstrap };
}

function configSetFrame(sessionId: string, token: string, value: string) {
	return {
		type: "config-set",
		sessionId,
		token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		key: ASSET_DIRECTORY_CONFIG_KEY,
		value,
	};
}

function configGetFrame(sessionId: string, token: string) {
	return {
		type: "config-get",
		sessionId,
		token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		key: ASSET_DIRECTORY_CONFIG_KEY,
	};
}

describe("config-get/config-set wire round trip", () => {
	it("persists an authenticated, valid asset directory and hands it back on config-get", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		const newDir = mkdtempSync(join(tmpdir(), "dg-asset-dir-set-"));

		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, newDir),
			),
		);
		const setReply = (await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { type?: string; key?: string }).type === "config-result" &&
						(f as { key?: string }).key === ASSET_DIRECTORY_CONFIG_KEY,
				),
			3000,
			"a config-result reply to config-set",
		)) as { value?: string; error?: string };
		expect(setReply.error).toBeUndefined();

		frames.length = 0;
		ws.send(
			JSON.stringify(configGetFrame(bootstrap.sessionId, bootstrap.token)),
		);
		const getReply = (await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { type?: string; key?: string }).type === "config-result" &&
						(f as { key?: string }).key === ASSET_DIRECTORY_CONFIG_KEY,
				),
			3000,
			"a config-result reply to config-get",
		)) as { value?: string };
		expect(getReply.value).toBe(newDir);
		ws.close();
	});

	it("refuses an unauthenticated (bad token) config-get/config-set attempt", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);

		ws.send(
			JSON.stringify(configGetFrame(bootstrap.sessionId, "not-the-real-token")),
		);
		const reply = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type !== undefined),
			2000,
			"a reply to the unauthenticated config-get",
		);
		expect((reply as { type?: string }).type).toBe("error");
		expect((reply as { type?: string }).type).not.toBe("config-result");
		ws.close();
	});

	it("rejects an unwritable directory at configuration time, naming the reason, and persists nothing", async () => {
		const { port, bootstrap, dgHome: home } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		const scratch = mkdtempSync(join(tmpdir(), "dg-asset-dir-unwritable-"));
		const notADirectory = join(scratch, "a-file");
		writeFileSync(notADirectory, "x");
		const badDir = join(notADirectory, "subdir");

		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, badDir),
			),
		);
		const reply = (await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { type?: string; key?: string }).type === "config-result" &&
						(f as { key?: string }).key === ASSET_DIRECTORY_CONFIG_KEY,
				),
			3000,
			"a config-result reply naming the rejection reason",
		)) as { error?: string };
		expect(typeof reply.error).toBe("string");
		expect((reply.error as string).length).toBeGreaterThan(0);

		const paths = resolveDgPaths({ env: { DG_HOME: home } });
		const persisted = readConfig(paths);
		expect(persisted[ASSET_DIRECTORY_CONFIG_KEY]).not.toBe(badDir);
		ws.close();
	});

	it("is daemon-authoritative: a value persisted before a restart is still what a fresh daemon reports, independent of any client-held value", async () => {
		const { port, bootstrap, dgHome: home } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		const persistedDir = mkdtempSync(join(tmpdir(), "dg-asset-dir-restart-"));
		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, persistedDir),
			),
		);
		await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { type?: string; key?: string }).type === "config-result" &&
						(f as { key?: string }).key === ASSET_DIRECTORY_CONFIG_KEY,
				),
			3000,
			"the config-set to complete",
		);
		ws.close();
		killDaemonByLockfile(home);

		const port2 = allocatePort();
		const restarted = await runStart(home, port2);
		await waitForHealth(port2);
		const bootstrap2 = validateSessionBootstrap(
			decodeChatMarker(extractUrl(restarted.stdout)),
		);
		const ws2 = await connectCli(port2, bootstrap2);
		const frames2 = collectFrames(ws2);
		ws2.send(
			JSON.stringify(configGetFrame(bootstrap2.sessionId, bootstrap2.token)),
		);
		const reply2 = (await waitForValue(
			() =>
				frames2.find(
					(f) =>
						(f as { type?: string; key?: string }).type === "config-result" &&
						(f as { key?: string }).key === ASSET_DIRECTORY_CONFIG_KEY,
				),
			3000,
			"a config-result reply from the restarted daemon",
		)) as { value?: string };
		expect(reply2.value).toBe(persistedDir);
		ws2.close();
	});
});
