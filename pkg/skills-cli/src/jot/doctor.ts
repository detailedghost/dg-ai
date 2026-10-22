import {
	allowRuleCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const jotChecks: DoctorCheck[] = [
	skillFilesCheck(["jot"]),
	allowRuleCheck("jot"),
];
