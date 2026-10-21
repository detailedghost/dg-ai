import { scratchRoot, shellCommand, stateRoot } from "@dg/common/node";
import { bootstrapCommand, PLUGIN_INSTALL, PLUGIN_UPDATE } from "./checks";
import { installedPlugins, isOlder, writableDirectory } from "./probes";
import { type DoctorCheck, type DoctorContext, fail, ok, warn } from "./types";

function rootCheck(
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
			const plugin = installedPlugins(ctx.home)[0];
			if (!plugin)
				return ok(`dg-skills ${ctx.installedVersion}; no plugin to compare`);
			if (isOlder(ctx.installedVersion, plugin.version))
				return fail(
					`dg-skills ${ctx.installedVersion} is older than the dg plugin ${plugin.version}`,
					bootstrapCommand(plugin.version, ctx),
				);
			if (isOlder(plugin.version, ctx.installedVersion))
				return warn(
					`the dg plugin ${plugin.version} is older than dg-skills ${ctx.installedVersion}`,
					PLUGIN_UPDATE,
				);
			return ok(`dg-skills and the dg plugin are both ${ctx.installedVersion}`);
		},
	},
	rootCheck("scratch-root", "scratch", ({ env }) => scratchRoot(env)),
	rootCheck("state-root", "state", ({ env, home }) => stateRoot(env, home)),
];

