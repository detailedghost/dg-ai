import {
	allowRuleCheck,
	gitCheck,
	vcsCliCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const vcsProviderChecks: DoctorCheck[] = [
	gitCheck(),
	vcsCliCheck(),
	allowRuleCheck("vcs-provider"),
];
