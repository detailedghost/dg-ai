import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const addressChecks: DoctorCheck[] = [
	skillFilesCheck(["address"]),
	gitCheck(),
	vcsCliCheck(),
	allowRuleCheck("address"),
];
