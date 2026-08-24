import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	ASSET_DIRECTORY_CONFIG_KEY,
	DAEMON_ASSET_LEAF,
	getAssetDirectorySetting,
	getConfiguredAssetDirectory,
	validateAssetDirectory,
} from "../../src/assets/config";
import { readConfig, writeConfig } from "../../src/server/config-store";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	connectCli,
	connectPage,
	freshTempDir as freshDaemonTempDir,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	spawnServe,
	startWithSession,
	waitForHealth,
	waitForValue,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	if (!dgHome) return;
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
	dgHome = "";
});

function freshTempDir(label: string): string {
	return freshDaemonTempDir(`dg-asset-dir-${label}`);
}

describe("validateAssetDirectory", () => {
	it("accepts an existing writable directory", () => {
		const dir = freshTempDir("ok");
		expect(validateAssetDirectory(dir)).toEqual({ ok: true, value: dir });
	});

	it("rejects a path that cannot be a directory at all, naming the reason — portable even under root", () => {
		const scratch = freshTempDir("bad");
		const notADirectory = join(scratch, "this-is-a-file");
		writeFileSync(notADirectory, "not a directory");
		const impossiblePath = join(notADirectory, "subdir");

		const result = validateAssetDirectory(impossiblePath);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});

	it("creates nothing: a probing config-set must not double as a mkdir primitive", () => {
		const scratch = freshTempDir("nomkdir");
		const candidate = join(scratch, "should-not-appear");

		expect(validateAssetDirectory(candidate).ok).toBe(false);
		expect(existsSync(candidate)).toBe(false);
	});

	it("rejects a relative path — a cwd-relative assets root means a different directory per caller", () => {
		const result = validateAssetDirectory("relative/assets");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/absolute/i);
	});

	it("rejects a symlink, even one pointing at a perfectly writable directory", () => {
		const parent = freshTempDir("symlink");
		const real = join(parent, "real-target");
		mkdirSync(real);
		const link = join(parent, "linked");
		symlinkSync(real, link);

		const result = validateAssetDirectory(link);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/symbolic link/i);
	});

	it.skipIf(process.getuid?.() === 0)(
		"rejects a directory that exists but is not writable, naming that reason",
		() => {
			const unwritable = freshTempDir("unwritable");
			chmodSync(unwritable, 0o500);
			try {
				const result = validateAssetDirectory(unwritable);
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.reason).toMatch(/not writable/i);
			} finally {
				chmodSync(unwritable, 0o700);
			}
		},
	);
});

describe("asset directory resolution", () => {
	it("falls back to resolveDgPaths' own assetsDir when nothing has been persisted yet — per-OS resolution stays the shared path module's job", () => {
		const home = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			expect(getAssetDirectorySetting(paths)).toBe(paths.assetsDir);
			expect(getConfiguredAssetDirectory(paths)).toBe(
				join(paths.assetsDir, DAEMON_ASSET_LEAF),
			);
		} finally {
			cleanupDgHome(home);
		}
	});

	it("treats a persisted value as the PARENT and appends the daemon-owned leaf, which is also the migration for values stored before it existed", () => {
		const home = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			const parent = freshTempDir("parent");
			writeConfig(paths, { [ASSET_DIRECTORY_CONFIG_KEY]: parent });

			expect(getAssetDirectorySetting(paths)).toBe(parent);
			expect(getConfiguredAssetDirectory(paths)).toBe(
				join(parent, DAEMON_ASSET_LEAF),
			);
		} finally {
			cleanupDgHome(home);
		}
	});
});

async function bootSession() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	return started;
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

type ConfigReply = { value?: string; error?: string };

function awaitConfigResult(
	frames: unknown[],
	label: string,
): Promise<ConfigReply> {
	return waitForValue(
		() =>
			frames.find(
				(f) =>
					(f as { type?: string }).type === "config-result" &&
					(f as { key?: string }).key === ASSET_DIRECTORY_CONFIG_KEY,
			),
		3000,
		label,
	) as Promise<ConfigReply>;
}

describe("config-get/config-set wire round trip", () => {
	it("persists an authenticated, valid asset directory and hands the same value back on config-get", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectPage(port, bootstrap);
		const frames = collectFrames(ws);
		const newDir = freshTempDir("set");

		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, newDir),
			),
		);
		const setReply = await awaitConfigResult(
			frames,
			"a config-result reply to config-set",
		);
		expect(setReply.error).toBeUndefined();
		expect(setReply.value).toBe(newDir);

		frames.length = 0;
		ws.send(
			JSON.stringify(configGetFrame(bootstrap.sessionId, bootstrap.token)),
		);
		const getReply = await awaitConfigResult(
			frames,
			"a config-result reply to config-get",
		);
		expect(getReply.value).toBe(newDir);
		ws.close();
	}, 30000);

	it("refuses config-set on a /cli socket — an agent's session token must not write a filesystem path", async () => {
		const { port, bootstrap, dgHome: home } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		const newDir = freshTempDir("cli-refused");

		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, newDir),
			),
		);
		const reply = await awaitConfigResult(
			frames,
			"a config-result refusal on the /cli socket",
		);
		expect(reply.error).toMatch(/extension socket/i);

		const paths = resolveDgPaths({ env: { DG_HOME: home } });
		expect(readConfig(paths)[ASSET_DIRECTORY_CONFIG_KEY]).toBeUndefined();
		ws.close();
	}, 30000);

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
	}, 30000);

	it("rejects an unwritable directory at configuration time, naming the reason, and persists nothing", async () => {
		const { port, bootstrap, dgHome: home } = await bootSession();
		const ws = await connectPage(port, bootstrap);
		const frames = collectFrames(ws);
		const scratch = freshTempDir("unwritable-wire");
		const notADirectory = join(scratch, "a-file");
		writeFileSync(notADirectory, "x");
		const badDir = join(notADirectory, "subdir");

		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, badDir),
			),
		);
		const reply = await awaitConfigResult(
			frames,
			"a config-result reply naming the rejection reason",
		);
		expect(typeof reply.error).toBe("string");
		expect((reply.error as string).length).toBeGreaterThan(0);

		const paths = resolveDgPaths({ env: { DG_HOME: home } });
		expect(readConfig(paths)[ASSET_DIRECTORY_CONFIG_KEY]).not.toBe(badDir);
		ws.close();
	}, 30000);

	it("is daemon-authoritative: a value persisted before a restart is still what a fresh daemon reports, independent of any client-held value", async () => {
		const { port, bootstrap, dgHome: home } = await bootSession();
		const ws = await connectPage(port, bootstrap);
		const frames = collectFrames(ws);
		const persistedDir = freshTempDir("restart");
		ws.send(
			JSON.stringify(
				configSetFrame(bootstrap.sessionId, bootstrap.token, persistedDir),
			),
		);
		await awaitConfigResult(frames, "the config-set to complete");
		ws.close();
		killDaemonByPidFile(home);

		const port2 = allocatePort();
		spawnServe(home, port2);
		await waitForHealth(port2);
		const bootstrap2 = await registerSession(port2);
		const ws2 = await connectPage(port2, bootstrap2);
		const frames2 = collectFrames(ws2);
		ws2.send(
			JSON.stringify(configGetFrame(bootstrap2.sessionId, bootstrap2.token)),
		);
		const reply2 = await awaitConfigResult(
			frames2,
			"a config-result reply from the restarted daemon",
		);
		expect(reply2.value).toBe(persistedDir);
		ws2.close();
	}, 45000);
});
