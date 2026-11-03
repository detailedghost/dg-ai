import { homedir } from "node:os";
import { delimiter, posix, win32 } from "node:path";

export type SystemSeams = {
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: Record<string, string | undefined>;
};

export type DgRoots = {
	binDir: string;
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	logDir: string;
};

export type DgPaths = DgRoots & {
	configPath: string;
	cliOnlyMarker: string;
	runtimeDir: string;
	libDir: string;
	browsersDir: string;
	skillsDir: string;
	personasDir: string;
	daemonDir: string;
	pidPath: string;
	dbPath: string;
	credentialsDbPath: string;
	keyPath: string;
	daemonConfigPath: string;
	pairingPath: string;
	agentsDir: string;
	sessionsDir: string;
	assetsDir: string;
	memoryDbPath: string;
	grantsDir: string;
	phoneRoot: string;
	phoneFriendRoot: string;
	legacyHome: string;
};

type Env = Record<string, string | undefined>;

function dgHome(platform: NodeJS.Platform, value: string): string {
	const path = platform === "win32" ? win32 : posix;
	return path.isAbsolute(value) ? value : path.resolve(value);
}

function roots(platform: NodeJS.Platform, home: string, env: Env): DgRoots {
	const path = platform === "win32" ? win32 : posix;
	if (env.DG_HOME) {
		const root = dgHome(platform, env.DG_HOME);
		return {
			binDir: path.join(root, "bin"),
			configDir: path.join(root, "config"),
			dataDir: path.join(root, "data"),
			stateDir: path.join(root, "state"),
			cacheDir: path.join(root, "cache"),
			logDir: path.join(root, "log"),
		};
	}
	if (platform === "win32") {
		const local = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "dg");
		return {
			binDir: path.join(local, "bin"),
			configDir: path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "dg"),
			dataDir: local,
			stateDir: path.join(local, "state"),
			cacheDir: path.join(local, "cache"),
			logDir: path.join(local, "log"),
		};
	}
	if (platform === "darwin") {
		const support = path.join(home, "Library", "Application Support", "dg");
		return {
			binDir: path.join(home, ".local", "bin"),
			configDir: support,
			dataDir: support,
			stateDir: path.join(support, "state"),
			cacheDir: path.join(home, "Library", "Caches", "dg"),
			logDir: path.join(home, "Library", "Logs", "dg"),
		};
	}
	const xdg = (name: string, ...fallback: string[]) => {
		const root = env[name];
		return path.join(root && path.isAbsolute(root) ? root : path.join(home, ...fallback), "dg");
	};
	const stateDir = xdg("XDG_STATE_HOME", ".local", "state");
	return {
		binDir: path.join(home, ".local", "bin"),
		configDir: xdg("XDG_CONFIG_HOME", ".config"),
		dataDir: xdg("XDG_DATA_HOME", ".local", "share"),
		stateDir,
		cacheDir: xdg("XDG_CACHE_HOME", ".cache"),
		logDir: path.join(stateDir, "log"),
	};
}

function legacyHome(platform: NodeJS.Platform, home: string, env: Env): string {
	if (env.DG_HOME) return dgHome(platform, env.DG_HOME);
	if (platform === "win32") return win32.join(env.USERPROFILE || home, ".dg");
	return posix.join(home, ".dg");
}

/** Every dg root and file for this OS; a non-empty `DG_HOME` maps each role to `<DG_HOME>/<role>`. */
export function resolveDgPaths(seams: SystemSeams = {}): DgPaths {
	const platform = seams.platform ?? process.platform;
	const home = seams.homeDir ?? homedir();
	const env = seams.env ?? process.env;
	const path = platform === "win32" ? win32 : posix;
	const r = roots(platform, home, env);
	const daemonDir = path.join(r.stateDir, "daemon");
	const agentsDir = path.join(r.stateDir, "agents");
	return {
		...r,
		configPath: path.join(r.configDir, "config.json"),
		cliOnlyMarker: path.join(r.configDir, "cli-only"),
		runtimeDir: path.join(r.dataDir, "runtime"),
		libDir: path.join(r.dataDir, "lib"),
		browsersDir: path.join(r.dataDir, "browsers"),
		skillsDir: path.join(r.dataDir, "skills"),
		personasDir: path.join(r.dataDir, "agents"),
		daemonDir,
		pidPath: path.join(daemonDir, "daemon.pid"),
		dbPath: path.join(daemonDir, "daemon.db"),
		credentialsDbPath: path.join(daemonDir, "credentials.db"),
		keyPath: path.join(daemonDir, "key"),
		daemonConfigPath: path.join(daemonDir, "config.json"),
		pairingPath: path.join(r.stateDir, "pairing.json"),
		agentsDir,
		sessionsDir: path.join(agentsDir, "sessions"),
		assetsDir: path.join(agentsDir, "assets"),
		memoryDbPath: path.join(agentsDir, "memory.db"),
		grantsDir: path.join(r.stateDir, "grants"),
		phoneRoot: path.join(r.stateDir, "phone"),
		phoneFriendRoot: path.join(r.stateDir, "phone-friend"),
		legacyHome: legacyHome(platform, home, env),
	};
}

/** `PATH` with the dg launcher folder first, so children call the launchers by name. */
export function withBinOnPath(path: string | undefined, binDir: string = resolveDgPaths().binDir): string {
	const parts = (path ?? "").split(delimiter).filter(Boolean);
	return [binDir, ...parts.filter((part) => part !== binDir)].join(delimiter);
}
