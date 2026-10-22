import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const monolithChecks: DoctorCheck[] = [
	skillFilesCheck(["monolith", "spring-break"]),
	gitCheck(),
	allowRuleCheck("monolith"),
];
