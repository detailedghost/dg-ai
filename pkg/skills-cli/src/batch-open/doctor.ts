import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const batchOpenChecks: DoctorCheck[] = [
	skillFilesCheck(["browser"]),
	...extensionChecks,
	allowRuleCheck("batch-open"),
];
