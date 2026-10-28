import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const assignChecks: DoctorCheck[] = [
	skillFilesCheck(["assign"]),
	allowRuleCheck("assign"),
];
