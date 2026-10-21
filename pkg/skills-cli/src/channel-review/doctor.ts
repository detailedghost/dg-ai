import { DATADOG_CREDENTIAL, SENTRY_CREDENTIAL } from "@dg/channel-review";
import {
	allowRuleCheck,
	anyToolCheck,
	credentialChecks,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const channelReviewChecks: DoctorCheck[] = [
	skillFilesCheck(["channel-review"]),
	gitCheck(),
	anyToolCheck("tool-agent", [{ tool: "claude" }, { tool: "codex" }], {
		required: true,
		why: "channel-review runs reviews through a coding agent",
	}),
	...credentialChecks([DATADOG_CREDENTIAL, SENTRY_CREDENTIAL]),
	allowRuleCheck("channel-review"),
];
