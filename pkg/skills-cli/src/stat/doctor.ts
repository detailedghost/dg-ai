import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const statChecks: DoctorCheck[] = [
	skillFilesCheck(["stat"]),
	allowRuleCheck("stat"),
];
