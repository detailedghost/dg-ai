import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const skillSplitChecks: DoctorCheck[] = [
	skillFilesCheck(["skill-cleanup"]),
	allowRuleCheck("skill-split"),
];
