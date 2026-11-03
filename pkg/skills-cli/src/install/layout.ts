import { delimiter } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { syncCompatLaunchers } from "./compat-launchers";
import { migrateLegacyHome } from "./migrate-home";
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

/** Moves an old flat `~/.dg` into the per-OS roots before install writes anything. */
export function migrateBeforeInstall(paths: DgPaths = resolveDgPaths(), log: (line: string) => void = console.log): void {
	const result = migrateLegacyHome(paths, { log });
	if (result.moved.length > 0) log(`dg: moved ${result.moved.length} items from ${paths.legacyHome} to the per-OS folders`);
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
