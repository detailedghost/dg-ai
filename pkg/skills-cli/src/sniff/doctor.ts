import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const sniffChecks: DoctorCheck[] = [
	skillFilesCheck(["sniff", "nope"]),
	gitCheck(),
	allowRuleCheck("sniff"),
];
