import { existsSync } from "node:fs";
import {
	channelReviewPaths,
	DATADOG_CREDENTIAL,
	loadConfig,
	resolveEnv,
	SENTRY_CREDENTIAL,
} from "@dg/channel-review";
import { describeError } from "@dg/common";
import {
	allowRuleCheck,
	anyToolCheck,
	credentialChecks,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import { CLI_PATH } from "../doctor/probes";
import { type DoctorCheck, fail, ok } from "../doctor/types";

export const configCheck: DoctorCheck = {
	id: "config",
	run(ctx) {
		const path = channelReviewPaths("dev", { homeDir: ctx.home, env: ctx.env }).configPath;
		const setup = `${CLI_PATH} channel-review setup`;
		if (!existsSync(path)) return fail(`no config at ${path}`, setup);
		try {
			resolveEnv(loadConfig(path, { homeDir: ctx.home, env: ctx.env }));
			return ok(`config ${path} is valid`);
		} catch (error) {
			return fail(describeError(error), `fix ${path}, or run ${setup} --force`);
		}
	},
};

export const channelReviewChecks: DoctorCheck[] = [
	skillFilesCheck(["channel-review"]),
	configCheck,
	gitCheck(),
	anyToolCheck("tool-agent", [{ tool: "claude" }, { tool: "codex" }], {
		required: true,
		why: "channel-review runs reviews through a coding agent",
	}),
	...credentialChecks([DATADOG_CREDENTIAL, SENTRY_CREDENTIAL]),
	allowRuleCheck("channel-review"),
];
