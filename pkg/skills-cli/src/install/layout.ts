import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { accountHome, allowSendHome } from "@dg/ssms";
import { moveVerified, withInstallLock } from "@dg/common/node";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { isLive } from "@dg/common/node/layout-work";
import { syncCompatLaunchers } from "./compat-launchers";
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
		log(`dg: kept ${allowFile}; a process that writes it is running. Stop it, then run dg-skills install again`);
		return;
	}
	moveVerified(allowFile, join(trustedConfig, "ssms", "config.yaml"), { log });
}

/** Moves the fixed ssms allow file from the passwd home into the trusted config folder. */
export async function migrateBeforeInstall(
	paths: DgPaths = resolveDgPaths(),
	log: (line: string) => void = console.log,
	passwdHome: string | undefined = installPasswdHome(),
): Promise<void> {
	const passwdLegacy = passwdHome && resolveDgPaths({ homeDir: passwdHome, env: {} }).legacyHome;
	const trustedConfig = passwdHome && allowSendHome(passwdHome);
	if (!passwdLegacy || !trustedConfig) return;
	await withInstallLock(paths.dataDir, () => moveSsmsAllowFile(passwdLegacy, trustedConfig, log));
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
