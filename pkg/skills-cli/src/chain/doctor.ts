import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const chainChecks: DoctorCheck[] = [
	skillFilesCheck(["chain"]),
	gitCheck(),
	vcsCliCheck(),
	allowRuleCheck("chain"),
];
