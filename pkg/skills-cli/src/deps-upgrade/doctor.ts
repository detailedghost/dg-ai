import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const depsUpgradeChecks: DoctorCheck[] = [
	skillFilesCheck(["deps-upgrade"]),
	gitCheck(),
	vcsCliCheck(),
	allowRuleCheck("deps-upgrade"),
];
