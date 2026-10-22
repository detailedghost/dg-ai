import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const thrashChecks: DoctorCheck[] = [
	skillFilesCheck(["thrash"]),
	gitCheck(),
	vcsCliCheck(),
	allowRuleCheck("thrash"),
];
