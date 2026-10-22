import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const meaningfulChecks: DoctorCheck[] = [
	skillFilesCheck(["meaningful"]),
	gitCheck(),
	allowRuleCheck("meaningful"),
];
