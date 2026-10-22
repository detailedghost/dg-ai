import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const inboxChecks: DoctorCheck[] = [
	skillFilesCheck(["inbox-cleanup"]),
	...extensionChecks,
	allowRuleCheck("inbox"),
];
