import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const skillAuditChecks: DoctorCheck[] = [
	skillFilesCheck(["skill-cleanup"]),
	allowRuleCheck("skill-audit"),
];
