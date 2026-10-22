import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const requireExtensionChecks: DoctorCheck[] = [
	skillFilesCheck(["chat", "overwatch"]),
	...extensionChecks,
	allowRuleCheck("require-extension"),
];
