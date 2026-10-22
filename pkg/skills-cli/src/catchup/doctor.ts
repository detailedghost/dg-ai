import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const catchupChecks: DoctorCheck[] = [
	skillFilesCheck(["catchup"]),
	gitCheck(),
	allowRuleCheck("catchup"),
];
