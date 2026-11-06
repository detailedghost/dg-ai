import { rmSync } from "node:fs";
import { join } from "node:path";
import { type DgPaths, withInstallLock } from "@dg/common/node";
import { layoutResult, resolveSeams, withCliLockError } from "@dg/common/node/layout";
import { isDaemonLive, readPidFile } from "@dg/common/node/pidfile";
import { pidAlive } from "@dg/common/node/plugin-cache";
import { resolveKeyMode } from "./crypto/key-resolution";
import { keychainAccountsForPaths, nativeBackendFor } from "./crypto/keychain-backends";
import { type KeychainMoveResult, type KeychainPair, moveKeychainKey } from "./crypto/keychain-step";

type DaemonHandle = Parameters<typeof isDaemonLive>[0];

const STOP_CAP_MS = 5000;
const POLL_MS = 100;

type StopResult = "stopped" | "still-running" | "refused";

export type DaemonLayoutDeps = {
	kill: (pid: number, signal: NodeJS.Signals) => void;
	isLive: (handle: DaemonHandle) => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	warn: (line: string) => void;
	backends: (paths: DgPaths) => KeychainPair;
};

const nativeBackends =
	(platform: NodeJS.Platform) =>
	(paths: DgPaths): KeychainPair => {
		const backendFor = nativeBackendFor(platform);
		if (!backendFor) throw new Error(`no keychain backend on ${platform}`);
		const accounts = keychainAccountsForPaths(paths);
		return { current: backendFor(accounts.current), legacy: backendFor(accounts.legacy) };
	};

function accountNames(paths: DgPaths): { currentAccount: string; legacyAccount: string } {
	const { current, legacy } = keychainAccountsForPaths(paths);
	return { currentAccount: current, legacyAccount: legacy };
}

type KeychainMoveDeps = Pick<DaemonLayoutDeps, "platform" | "env" | "warn" | "backends">;

function keychainMoveStep({ platform, env, warn, backends }: KeychainMoveDeps): (paths: DgPaths) => Promise<KeychainMoveResult> {
	const lock = withCliLockError((root, fn) => withInstallLock(root, fn));
	const moves = new Map<string, Promise<KeychainMoveResult>>();
	return (paths) => {
		const daemonOutcome = layoutResult(paths)?.daemon.kind;
		if (daemonOutcome === "blocked" || daemonOutcome === "failed") return Promise.resolve("kept");
		if ((platform !== "linux" && platform !== "darwin") || resolveKeyMode(env.DG_KEY_SOURCE) === "file") {
			return Promise.resolve("absent");
		}
		const known = moves.get(paths.legacyHome);
		if (known) return known;
		const running = lock(paths.dataDir, () =>
			moveKeychainKey({
				pair: backends(paths),
				...accountNames(paths),
				daemonOutcome,
				warn,
			}),
		);
		moves.set(paths.legacyHome, running);
		return running;
	};
}

/** The `daemon.stop` hook and the `keychainMove` post-step. */
export function daemonLayoutHooks({
	kill = (pid, signal) => void process.kill(pid, signal),
	isLive = (handle) => isDaemonLive(handle),
	sleep = (ms) => Bun.sleep(ms),
	platform = process.platform,
	env = process.env,
	warn = (line) => resolveSeams({}).log(line),
	backends = nativeBackends(platform),
}: Partial<DaemonLayoutDeps> = {}): {
	"daemon.stop": (legacyDaemonDir: string) => Promise<StopResult>;
	keychainMove: (paths: DgPaths) => Promise<KeychainMoveResult>;
} {
	return {
		keychainMove: keychainMoveStep({ platform, env, warn, backends }),
		"daemon.stop": async (legacyDaemonDir) => {
			if (platform === "win32") {
				process.stderr.write(
					`dg: kept ${legacyDaemonDir}; stop the dg-daemon service, then run dg-skills install again\n`,
				);
				return "refused";
			}
			const pidPath = join(legacyDaemonDir, "daemon.pid");
			const handle = readPidFile({ pidPath });
			if (!handle || !(await isLive(handle))) {
				if (!handle || !pidAlive(handle.pid)) rmSync(pidPath, { force: true });
				return "stopped";
			}
			try {
				kill(handle.pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return "stopped";
				throw error;
			}
			for (let waited = 0; waited < STOP_CAP_MS; waited += POLL_MS) {
				await sleep(POLL_MS);
				if (!pidAlive(handle.pid)) return "stopped";
			}
			return "still-running";
		},
	};
}
