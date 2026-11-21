import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { accountHome, allowSendHome } from "@dg/ssms";
import { moveVerified, withInstallLock } from "@dg/common/node";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { isLive } from "@dg/common/node/layout-work";
import { cliLauncher } from "../doctor/probes";
import { relaunchHooks } from "../hooks/relaunch";
import { removeCompatLaunchers } from "./compat-launchers";
import { removeOldLaunchers, writeDgLink } from "./compiled";

type LayoutOptions = {
	paths?: DgPaths;
	envPath?: string;
	log?: (line: string) => void;
	platform?: NodeJS.Platform;
	home?: string;
	env?: Record<string, string | undefined>;
	bridge?: boolean;
};

/** The shell line that puts the bin dir on PATH, or undefined when PATH has it or on Windows. */
export function pathHint(binDir: string, envPath: string, platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform === "win32") return undefined;
	if (envPath.split(delimiter).includes(binDir)) return undefined;
	return `Add to PATH:  export PATH="${binDir}:$PATH"`;
}

/** The home whose agent settings install may rewrite; under the test runner only a HOME that is not the account home. */
export function hooksHome(
	env: NodeJS.ProcessEnv = process.env,
	lookup: () => string | undefined = accountHome,
): string | undefined {
	if (env.NODE_ENV !== "test") return homedir();
	const home = env.HOME;
	const account = lookup();
	return home && account && resolve(home) !== resolve(account) ? home : undefined;
}

/** The passwd home for install; none under the test runner, so a spawned install never reaches the real account. */
export function installPasswdHome(
	env: NodeJS.ProcessEnv = process.env,
	lookup: () => string | undefined = accountHome,
): string | undefined {
	return env.NODE_ENV === "test" ? undefined : lookup();
}

function moveSsmsAllowFile(passwdLegacy: string, trustedConfig: string, log: (line: string) => void): void {
	const ssmsDir = join(passwdLegacy, "ssms");
	const allowFile = join(ssmsDir, "config.yaml");
	if (!existsSync(allowFile)) return;
	if (isLive(passwdLegacy, "ssms/*.pid")) {
		log(`dg: kept ${allowFile}; a process that writes it is running. Stop it, then run dg install again`);
		return;
	}
	moveVerified(allowFile, join(trustedConfig, "ssms", "config.yaml"), { log });
}

function passwdLocations(passwdHome: string | undefined): { legacy: string; trusted: string } | undefined {
	const legacy = passwdHome && resolveDgPaths({ homeDir: passwdHome, env: {} }).legacyHome;
	const trusted = passwdHome && allowSendHome(passwdHome);
	return legacy && trusted ? { legacy, trusted } : undefined;
}

/** The folder that holds ssms config: the trusted passwd-home folder when it shares this legacy home, else the config dir. */
export function ssmsConfigDir(paths: DgPaths, passwdHome: string | undefined = installPasswdHome()): string {
	const found = passwdLocations(passwdHome);
	return found && resolve(found.legacy) === resolve(paths.legacyHome) ? found.trusted : paths.configDir;
}

/** Moves the fixed ssms allow file from the passwd home into the trusted config folder. */
export async function migrateBeforeInstall(
	paths: DgPaths = resolveDgPaths(),
	log: (line: string) => void = console.log,
	passwdHome: string | undefined = installPasswdHome(),
): Promise<void> {
	const found = passwdLocations(passwdHome);
	if (!found) return;
	const { legacy: passwdLegacy, trusted: trustedConfig } = found;
	await withInstallLock(paths.dataDir, () => moveSsmsAllowFile(passwdLegacy, trustedConfig, log));
}

/**
 * Points `<bin>/dg` at the compiled program, removes the old launchers and the `~/.dg/bin` notice launchers,
 * moves hook commands off `dg-skills`, and prints the PATH hint. `bridge` is the 6.3 self-update step:
 * on Windows it leaves the running `.cmd` files for the next install.
 */
export async function finishLauncherLayout(version: string, opts: LayoutOptions = {}): Promise<void> {
	const paths = opts.paths ?? resolveDgPaths();
	const platform = opts.platform ?? process.platform;
	const log = opts.log ?? console.log;
	writeDgLink(paths.binDir, paths.dataDir, version, platform);
	removeOldLaunchers(paths.binDir, paths.dataDir, platform, { keepCmd: opts.bridge === true && platform === "win32" });
	removeCompatLaunchers(paths, platform);
	const home = opts.home ?? hooksHome();
	if (home) await relaunchHooks(cliLauncher(paths.binDir, platform), home, opts.env ?? process.env);
	const hint = pathHint(paths.binDir, opts.envPath ?? process.env.PATH ?? "", platform);
	if (hint) log(hint);
}
