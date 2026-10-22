import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellCommand } from "@dg/common/node";
import {
	allowRuleCheck,
	bootstrapCommand,
	skillFilesCheck,
} from "../doctor/checks";
import { CLI_PATH, writableDirectory } from "../doctor/probes";
import { type DoctorCheck, fail, ok, warn } from "../doctor/types";

const binDir = (stateDir: string): string => join(stateDir, "bin");

export const installChecks: DoctorCheck[] = [
	skillFilesCheck(["browser"]),
	{
		id: "cli-binary",
		run(ctx) {
			const dest = join(
				binDir(ctx.paths.stateDir),
				process.platform === "win32" ? "dg-skills.exe" : "dg-skills",
			);
			return existsSync(dest)
				? ok(`${CLI_PATH} is installed`)
				: warn(
						`${CLI_PATH} is not installed`,
						bootstrapCommand(ctx.installedVersion, ctx),
					);
		},
	},
	{
		id: "bin-dir",
		run(ctx) {
			const dir = binDir(ctx.paths.stateDir);
			const result = writableDirectory(dir);
			return result.writable
				? ok(`install directory ${dir} is writable`)
				: fail(
						`install directory ${dir} cannot be used: ${result.reason}`,
						`chmod u+rwx ${shellCommand([result.at])}`,
					);
		},
	},
	allowRuleCheck("install"),
];
