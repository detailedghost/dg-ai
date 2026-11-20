import { allowRuleCheck, credentialStoreCheck, daemonCheck, sessionCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const credentialsChecks: DoctorCheck[] = [
	daemonCheck,
	sessionCheck,
	credentialStoreCheck,
	allowRuleCheck("credentials"),
];
