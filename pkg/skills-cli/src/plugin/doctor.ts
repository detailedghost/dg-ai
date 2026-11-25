import { allowRuleCheck, gitCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const pluginChecks: DoctorCheck[] = [gitCheck(), allowRuleCheck("plugin")];
