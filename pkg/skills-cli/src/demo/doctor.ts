import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const demoChecks: DoctorCheck[] = [
	skillFilesCheck(["demo"]),
	...extensionChecks,
	allowRuleCheck("demo"),
];
