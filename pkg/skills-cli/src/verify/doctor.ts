import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const verifyChecks: DoctorCheck[] = [
	skillFilesCheck(["verify"]),
	allowRuleCheck("verify"),
];
