import { rmSync } from "node:fs";
import { join } from "node:path";
import { isDaemonLive, readPidFile } from "@dg/common/node/pidfile";
import { pidAlive } from "@dg/common/node/plugin-cache";

type DaemonHandle = Parameters<typeof isDaemonLive>[0];

const STOP_CAP_MS = 5000;
const POLL_MS = 100;

type StopResult = "stopped" | "still-running" | "refused";

export type DaemonLayoutDeps = {
	kill: (pid: number, signal: NodeJS.Signals) => void;
	isLive: (handle: DaemonHandle) => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	platform: NodeJS.Platform;
};

/** The `daemon.stop` hook: SIGTERM the old daemon named by the pid file in a legacy folder and wait for it to exit. */
export function daemonLayoutHooks({
	kill = (pid, signal) => void process.kill(pid, signal),
	isLive = (handle) => isDaemonLive(handle),
	sleep = (ms) => Bun.sleep(ms),
	platform = process.platform,
}: Partial<DaemonLayoutDeps> = {}): { "daemon.stop": (legacyDaemonDir: string) => Promise<StopResult> } {
	return {
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
