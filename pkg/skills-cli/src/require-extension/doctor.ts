import {
	allowRuleCheck,
	extOnlyChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const requireExtensionChecks: DoctorCheck[] = [
	skillFilesCheck(["chat", "overwatch"]),
	...extOnlyChecks,
	allowRuleCheck("require-extension"),
];
