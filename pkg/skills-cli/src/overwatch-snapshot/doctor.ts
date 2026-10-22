import { allowRuleCheck, daemonCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const overwatchSnapshotChecks: DoctorCheck[] = [
	skillFilesCheck(["overwatch"]),
	daemonCheck,
	allowRuleCheck("overwatch-snapshot"),
];
