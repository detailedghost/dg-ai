import { allowRuleCheck, gitCheck, skillFilesCheck, toolCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const testLiveChecks: DoctorCheck[] = [
	skillFilesCheck(["test-live"]),
	gitCheck(),
	toolCheck({ tool: "gh" }, { required: true, why: "test-live dispatches and watches GitHub Actions runs" }),
	allowRuleCheck("test-live"),
];
