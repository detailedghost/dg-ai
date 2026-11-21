import { describeError } from "@dg/common";
import { readDgToml } from "@dg/common/node";
import { allowRuleCheck } from "../doctor/checks";
import { type DoctorCheck, fail, ok } from "../doctor/types";

const configFileCheck: DoctorCheck = {
	id: "config-toml",
	run: (ctx) => {
		try {
			readDgToml(ctx.env);
			return ok(`${ctx.paths.configTomlPath} is valid`);
		} catch (error) {
			return fail(describeError(error), "dg config edit");
		}
	},
};

export const configChecks: DoctorCheck[] = [configFileCheck, allowRuleCheck("config")];
