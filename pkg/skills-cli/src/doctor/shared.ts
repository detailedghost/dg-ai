import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDgPaths, scratchRoot, shellCommand, stateRoot } from "@dg/common/node";
import { readCurrent } from "../install/current";
import { bootstrapCommand, PLUGIN_INSTALL, PLUGIN_UPDATE } from "./checks";
import { installedPlugins, isOlder, toolVersion, writableDirectory } from "./probes";
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
			const installed = readCurrent(ctx.paths.stateDir, "lib") ?? ctx.installedVersion;
			const plugin = installedPlugins(ctx.home)[0];
			if (!plugin) return ok(`dg-skills ${installed}; no plugin to compare`);
			if (isOlder(installed, plugin.version))
				return fail(
					`dg-skills ${installed} is older than the dg plugin ${plugin.version}`,
					bootstrapCommand(ctx),
				);
			if (isOlder(plugin.version, installed))
				return warn(
					`the dg plugin ${plugin.version} is older than dg-skills ${installed}`,
					PLUGIN_UPDATE,
				);
			return ok(`dg-skills and the dg plugin are both ${installed}`);
		},
	},
	{
		id: "runtime-present",
		run(ctx) {
			if (!readCurrent(ctx.paths.stateDir, "lib")) return ok("no bundle installed; running from source");
			const bun = join(ctx.paths.stateDir, "runtime", "current", process.platform === "win32" ? "bun.exe" : "bun");
			if (!existsSync(bun)) return fail(`the Bun runtime ${bun} is missing`, bootstrapCommand(ctx));
			const version = toolVersion(bun);
			return version
				? ok(`the Bun runtime ${bun} runs (bun ${version})`)
				: fail(`the Bun runtime ${bun} did not run --version`, bootstrapCommand(ctx));
		},
	},
	{
		id: "dg-home",
		run({ env, home }) {
			const defaultHome = resolveDgPaths({ homeDir: home, env: {} }).stateDir;
			if (!env.DG_HOME) return ok("DG_HOME is unset");
			return resolve(env.DG_HOME) !== resolve(defaultHome)
				? warn(`DG_HOME=${env.DG_HOME} moves the dg state directory away from ~/.dg`, "unset DG_HOME")
				: ok("DG_HOME uses the default state directory");
		},
	},
	rootCheck("scratch-root", "scratch", ({ env }) => scratchRoot(env)),
	rootCheck("state-root", "state", ({ env, home }) => stateRoot(env, home)),
];

