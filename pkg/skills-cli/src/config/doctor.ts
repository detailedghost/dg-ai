import { describeError } from "@dg/common";
import { readDgTomlFor } from "@dg/common/node";
import { allowRuleCheck, migratedSourcesCheck } from "../doctor/checks";
import { type DoctorCheck, fail, ok } from "../doctor/types";

const configFileCheck: DoctorCheck = {
	id: "config-toml",
	run: (ctx) => {
		try {
			readDgTomlFor(ctx.paths, { env: ctx.env, homeDir: ctx.home });
			return ok(`${ctx.paths.configTomlPath} is valid`);
		} catch (error) {
			return fail(describeError(error), "dg config edit");
		}
	},
};

export const configChecks: DoctorCheck[] = [configFileCheck, migratedSourcesCheck, allowRuleCheck("config")];
