import { allowRuleCheck, credentialStoreCheck, daemonCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const credentialsChecks: DoctorCheck[] = [
	daemonCheck,
	credentialStoreCheck,
	allowRuleCheck("credentials"),
];
