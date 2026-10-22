import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const skillPublishChecks: DoctorCheck[] = [
	skillFilesCheck(["skill-publish"]),
	allowRuleCheck("skill-publish"),
];
