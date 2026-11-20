import {
	allowRuleCheck,
	daemonCheck,
	sessionCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const dbChecks: DoctorCheck[] = [
	skillFilesCheck(["db"]),
	daemonCheck,
	sessionCheck,
	allowRuleCheck("db"),
];
