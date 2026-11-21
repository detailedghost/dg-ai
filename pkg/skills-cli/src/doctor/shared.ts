import { existsSync, lstatSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { scratchRoot, shellCommand, stateRoot } from "@dg/common/node";
import { compiledProgramPath } from "@dg/common/node/program";
import { readCurrent } from "../install/current";
import { isDgLauncher } from "../install/dg-launcher";
import { bootstrapCommand, PLUGIN_INSTALL, PLUGIN_UPDATE } from "./checks";
import { cliLauncher, installedPlugins, isOlder, toolVersion, writableDirectory } from "./probes";
import { type DoctorCheck, type DoctorContext, fail, ok, warn } from "./types";

export function rootCheck(
	id: string,
	label: string,
	root: (ctx: DoctorContext) => string,
): DoctorCheck {
	return {
		id,
		run(ctx) {
			const path = root(ctx);
			const result = writableDirectory(path);
			if (result.writable) return ok(`${label} root ${path} is writable`);
			return fail(
				`${label} root ${path} cannot be used: ${result.reason}`,
				result.kind === "not-directory"
					? `mv ${shellCommand([result.at, `${result.at}.old`])} && mkdir -p ${shellCommand([path])}`
					: `chmod u+rwx ${shellCommand([result.at])}`,
			);
		},
	};
}

export const SHARED_ITEM = "shared";

/** The shell line that puts the launcher folder first on PATH: PowerShell on Windows, POSIX sh elsewhere. */
export function launcherPathFix(binDir: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return `export PATH="${binDir}:$PATH"`;
	const quoted = binDir.replaceAll("'", "''");
	return `[Environment]::SetEnvironmentVariable('Path', '${quoted};' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')`;
}

const sameFile = (a: string, b: string): boolean => {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
};

export function dgLauncherCheck(
	cliOnly: (ctx: DoctorContext) => boolean,
	platform: NodeJS.Platform = process.platform,
): DoctorCheck {
	const file = platform === "win32" ? "dg.exe" : "dg";
	return {
		id: "dg-launcher",
		run(ctx) {
			const { binDir, dataDir } = ctx.paths;
			if (!readCurrent(dataDir, "bin")) return ok("no compiled dg installed; running from source");
			const launcher = cliLauncher(binDir, platform);
			try {
				lstatSync(launcher);
			} catch {
				return warn(`the dg launcher is missing from ${binDir}`, cliOnly(ctx) ? "dg install --cli-only" : "dg install");
			}
			if (!isDgLauncher(launcher, platform, dataDir))
				return warn(`${launcher} is not a dg launcher`, `remove or rename ${launcher}, then run dg install`);
			const onPath = Bun.which(file, { PATH: ctx.env.PATH ?? "" });
			if (onPath && !sameFile(onPath, launcher))
				return warn(`dg on PATH is ${onPath}, not ${launcher}`, launcherPathFix(binDir, platform));
			return ok(`the dg launcher ${launcher} is in place`);
		},
	};
}

export const sharedChecks: DoctorCheck[] = [
	{
		id: "plugin-installed",
		run(ctx) {
			return installedPlugins(ctx.home).length > 0
				? ok("the dg plugin is installed in the Claude plugin cache")
				: warn("the dg plugin was not found in the Claude plugin cache", PLUGIN_INSTALL);
		},
	},
	{
		id: "version-match",
		run(ctx) {
			const installed = readCurrent(ctx.paths.dataDir, "bin") ?? readCurrent(ctx.paths.dataDir, "lib") ?? ctx.installedVersion;
			const plugin = installedPlugins(ctx.home)[0];
			if (!plugin) return ok(`dg ${installed}; no plugin to compare`);
			if (isOlder(installed, plugin.version))
				return fail(
					`dg ${installed} is older than the dg plugin ${plugin.version}`,
					bootstrapCommand(ctx),
				);
			if (isOlder(plugin.version, installed))
				return warn(
					`the dg plugin ${plugin.version} is older than dg ${installed}`,
					PLUGIN_UPDATE,
				);
			return ok(`dg and the dg plugin are both ${installed}`);
		},
	},
	{
		id: "program-present",
		run(ctx) {
			if (!readCurrent(ctx.paths.dataDir, "bin")) return ok("no compiled dg installed; running from source");
			const program = compiledProgramPath(ctx.paths.dataDir);
			if (!existsSync(program)) return fail(`the dg program ${program} is missing`, bootstrapCommand(ctx));
			const version = toolVersion(program);
			return version
				? ok(`the dg program ${program} runs (dg ${version})`)
				: fail(`the dg program ${program} did not run --version`, bootstrapCommand(ctx));
		},
	},
	{
		id: "dg-home",
		run({ env }) {
			if (!env.DG_HOME) return ok("DG_HOME is unset");
			return warn(`DG_HOME=${env.DG_HOME} keeps every dg folder there instead of in the per-OS folders`, "unset DG_HOME");
		},
	},
	{
		id: "launcher-on-path",
		run(ctx) {
			const launcher = cliLauncher(ctx.paths.binDir);
			if (!existsSync(launcher)) return ok(`no dg launcher in ${ctx.paths.binDir}`);
			if ((ctx.env.PATH ?? "").split(delimiter).includes(ctx.paths.binDir))
				return ok(`${ctx.paths.binDir} is on PATH`);
			return warn(
				`${ctx.paths.binDir} is not on PATH, so skills fall back to the full launcher path`,
				launcherPathFix(ctx.paths.binDir),
			);
		},
	},
	rootCheck("scratch-root", "scratch", ({ env }) => scratchRoot(env)),
	rootCheck("state-root", "state", ({ env, home }) => stateRoot(env, home)),
];

