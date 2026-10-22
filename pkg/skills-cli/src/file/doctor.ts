import {
	allowRuleCheck,
	skillFilesCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const fileChecks: DoctorCheck[] = [
	skillFilesCheck(["file"]),
	vcsCliCheck(),
	allowRuleCheck("file"),
];
