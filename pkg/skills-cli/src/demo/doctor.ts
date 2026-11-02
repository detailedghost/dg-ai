import {
	allowRuleCheck,
	extOnlyChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";
import { browserStatusCheck } from "../pw/doctor";

export const demoChecks: DoctorCheck[] = [
	skillFilesCheck(["demo"]),
	browserStatusCheck,
	...extOnlyChecks,
	allowRuleCheck("demo"),
];
