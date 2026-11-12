import { existsSync } from "node:fs";
import {
	activeVersions,
	formatMegabytes,
	listDgPluginVersions,
	planPluginCachePrune,
	shellCommand,
} from "@dg/common/node";
import {
	allowRuleCheck,
	bootstrapCommand,
	skillFilesCheck,
} from "../doctor/checks";
import { CLI_PATH, cliLauncher, writableDirectory } from "../doctor/probes";
import { type DoctorCheck, fail, ok, warn } from "../doctor/types";

export const installChecks: DoctorCheck[] = [
	skillFilesCheck(["browser"]),
	{
		id: "cli-binary",
		run(ctx) {
			const dest = cliLauncher(ctx.paths.binDir);
			return existsSync(dest)
				? ok(`${CLI_PATH} is installed`)
				: warn(
						`${CLI_PATH} is not installed`,
						bootstrapCommand(ctx),
					);
		},
	},
	{
		id: "bin-dir",
		run(ctx) {
			const dir = ctx.paths.binDir;
			const result = writableDirectory(dir);
			return result.writable
				? ok(`install directory ${dir} is writable`)
				: fail(
						`install directory ${dir} cannot be used: ${result.reason}`,
						`chmod u+rwx ${shellCommand([result.at])}`,
					);
		},
	},
	{
		id: "plugin-cache",
		run(ctx) {
			const active = activeVersions(ctx.home);
			if (!active)
				return ok("plugin cache not checked: installed_plugins.json unreadable");
			const { remove } = planPluginCachePrune(
				listDgPluginVersions(ctx.home),
				active,
				Date.now(),
			);
			if (remove.length === 0) return ok("no stale dg plugin versions in the Claude plugin cache");
			const bytes = remove.reduce((sum, version) => sum + version.bytes, 0);
			return warn(
				`${remove.length} stale version(s), ${formatMegabytes(bytes)} reclaimable`,
				`${shellCommand([cliLauncher(ctx.paths.binDir)])} install`,
			);
		},
	},
	allowRuleCheck("install"),
];
