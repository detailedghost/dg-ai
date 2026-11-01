import {
	allowRuleCheck,
	extOnlyChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const batchOpenChecks: DoctorCheck[] = [
	skillFilesCheck(["browser"]),
	...extOnlyChecks,
	allowRuleCheck("batch-open"),
];
