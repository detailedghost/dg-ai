import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { accountHome, allowSendHome } from "@dg/ssms";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { syncCompatLaunchers } from "./compat-launchers";
import { migrateLegacyHome, moveVerified } from "./migrate-home";
import { writeShims } from "./shims";

type LayoutOptions = {
	paths?: DgPaths;
	envPath?: string;
	log?: (line: string) => void;
	platform?: NodeJS.Platform;
};

/** The shell line that puts the bin dir on PATH, or undefined when PATH has it or on Windows. */
export function pathHint(binDir: string, envPath: string, platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform === "win32") return undefined;
	if (envPath.split(delimiter).includes(binDir)) return undefined;
	return `Add to PATH:  export PATH="${binDir}:$PATH"`;
}

/** The passwd home, only when it is also `HOME`: a sandboxed or redirected `HOME` never moves the fixed ssms config. */
export function passwdHomeWhenCurrent(
	passwd: string | undefined = accountHome(),
	home: string | undefined = process.env.HOME,
): string | undefined {
	return passwd && home && resolve(passwd) === resolve(home) ? passwd : undefined;
}

/** Moves an old flat `~/.dg` into the per-OS roots before install writes anything. */
export function migrateBeforeInstall(
	paths: DgPaths = resolveDgPaths(),
	log: (line: string) => void = console.log,
	passwdHome: string | undefined = passwdHomeWhenCurrent(),
): void {
	const ssmsConfigDir = (passwdHome && allowSendHome(passwdHome)) || paths.configDir;
	const result = migrateLegacyHome(paths, { log, ssmsConfigDir });
	if (result.moved.length > 0) log(`dg: moved ${result.moved.length} items from ${paths.legacyHome} to the per-OS folders`);
	if (!passwdHome) return;
	const passwdLegacy = resolveDgPaths({ homeDir: passwdHome, env: {} }).legacyHome;
	const allowFile = join(passwdLegacy, "ssms", "config.yaml");
	if (passwdLegacy !== paths.legacyHome && existsSync(allowFile))
		moveVerified(allowFile, join(ssmsConfigDir, "ssms", "config.yaml"), { log });
}

/** Launchers in the bin dir that run the data dir bundle, the old-path notice launchers, and the PATH hint. */
export function finishLauncherLayout(version: string, opts: LayoutOptions = {}): void {
	const paths = opts.paths ?? resolveDgPaths();
	const platform = opts.platform ?? process.platform;
	const log = opts.log ?? console.log;
	writeShims(paths.binDir, paths.dataDir, platform);
	syncCompatLaunchers(paths, version, platform);
	const hint = pathHint(paths.binDir, opts.envPath ?? process.env.PATH ?? "", platform);
	if (hint) log(hint);
}
