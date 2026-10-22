import { allowRuleCheck, skillFilesCheck, unslopCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const polishChecks: DoctorCheck[] = [
	skillFilesCheck(["polish"]),
	unslopCheck,
	allowRuleCheck("chain"),
];
