import {
	allowRuleCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const bgChecks: DoctorCheck[] = [
	skillFilesCheck(["bg", "cls", "stat"]),
	allowRuleCheck("bg"),
];
