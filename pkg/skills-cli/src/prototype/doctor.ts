import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const prototypeChecks: DoctorCheck[] = [
	skillFilesCheck(["proto"]),
	allowRuleCheck("prototype"),
];
