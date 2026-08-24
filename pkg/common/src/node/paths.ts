import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type SystemSeams = {
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: Record<string, string | undefined>;
};

export type DgPaths = {
	stateDir: string;
	daemonDir: string;
	pidPath: string;
	dbPath: string;
	keyPath: string;
	configPath: string;
	logDir: string;
	agentsDir: string;
	sessionsDir: string;
	assetsDir: string;
	memoryDbPath: string;
};

export function resolveDgPaths(seams: SystemSeams = {}): DgPaths {
	const platform = seams.platform ?? process.platform;
	const homeDir = seams.homeDir ?? homedir();
	const env = seams.env ?? process.env;
	const path = platform === "win32" ? win32 : posix;

	const stateDir = env.DG_HOME ?? path.join(homeDir, ".dg");
	const daemonDir = path.join(stateDir, "daemon");
	const agentsDir = path.join(stateDir, "agents");

	return {
		stateDir,
		daemonDir,
		pidPath: path.join(daemonDir, "daemon.pid"),
		dbPath: path.join(daemonDir, "daemon.db"),
		keyPath: path.join(daemonDir, "key"),
		configPath: path.join(daemonDir, "config.json"),
		logDir: path.join(daemonDir, "logs"),
		agentsDir,
		sessionsDir: path.join(agentsDir, "sessions"),
		assetsDir: path.join(agentsDir, "assets"),
		memoryDbPath: path.join(agentsDir, "memory.db"),
	};
}
