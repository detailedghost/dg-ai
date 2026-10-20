import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const stashChecks: DoctorCheck[] = [
	skillFilesCheck(["stash"]),
	gitCheck(),
	allowRuleCheck("stash"),
];
