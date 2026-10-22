import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const specChecks: DoctorCheck[] = [
	skillFilesCheck(["spec", "kick", "pickup", "prd"]),
	gitCheck(),
	vcsCliCheck(false),
	allowRuleCheck("spec"),
];
