import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const erdChecks: DoctorCheck[] = [
	skillFilesCheck(["erd", "eli5"]),
	allowRuleCheck("erd"),
];
