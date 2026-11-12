import { allowRuleCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const skillChecks: DoctorCheck[] = [allowRuleCheck("skill")];
