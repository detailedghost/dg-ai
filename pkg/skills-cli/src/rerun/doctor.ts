import {
	allowRuleCheck,
	extOnlyChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";
import { browserStatusCheck } from "../pw/doctor";

export const rerunChecks: DoctorCheck[] = [
	skillFilesCheck(["demo"]),
	browserStatusCheck,
	...extOnlyChecks,
	allowRuleCheck("rerun"),
];
