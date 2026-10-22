import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const rerunChecks: DoctorCheck[] = [
	skillFilesCheck(["demo"]),
	...extensionChecks,
	allowRuleCheck("rerun"),
];
