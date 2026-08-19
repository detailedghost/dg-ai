import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type SystemSeams = {
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: Record<string, string | undefined>;
};

/** The six named ~/.dg paths, plus stateDir — the 0700 root they all live under. */
export type DgPaths = {
	stateDir: string;
	lockfilePath: string;
	dbPath: string;
	keyPath: string;
	assetsDir: string;
	sessionsDir: string;
	logPath: string;
};

/**
 * Resolve the daemon's uniform ~/.dg layout for the given platform.
 * DG_HOME replaces <home>/.dg wholesale — mirroring how protoScratchPath
 * treats AI_SCRATCH_DIR — and is the ONLY root override; AI_SCRATCH_DIR is
 * reboot-cleaned and must never affect this persistent root.
 */
export function resolveDgPaths(seams: SystemSeams = {}): DgPaths {
	const platform = seams.platform ?? process.platform;
	const homeDir = seams.homeDir ?? homedir();
	const env = seams.env ?? process.env;
	const path = platform === "win32" ? win32 : posix;

	const stateDir = env.DG_HOME ?? path.join(homeDir, ".dg");

	return {
		stateDir,
		lockfilePath: path.join(stateDir, "daemon.lock"),
		dbPath: path.join(stateDir, "chat.db"),
		keyPath: path.join(stateDir, "key"),
		assetsDir: path.join(stateDir, "assets"),
		sessionsDir: path.join(stateDir, "sessions"),
		logPath: path.join(stateDir, "daemon.log"),
	};
}
