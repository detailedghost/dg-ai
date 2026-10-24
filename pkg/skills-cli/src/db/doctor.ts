import {
	allowRuleCheck,
	daemonCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const dbChecks: DoctorCheck[] = [
	skillFilesCheck(["db"]),
	daemonCheck,
	allowRuleCheck("db"),
];
