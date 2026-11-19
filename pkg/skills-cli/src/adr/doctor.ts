import { allowRuleCheck, gitCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const adrChecks: DoctorCheck[] = [skillFilesCheck(["adr"]), gitCheck(), allowRuleCheck("adr")];
