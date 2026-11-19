import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const launchChecks: DoctorCheck[] = [
	skillFilesCheck(["pw"]),
	...extensionChecks,
	allowRuleCheck("pw"),
];
