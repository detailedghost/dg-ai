import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const updateChecks: DoctorCheck[] = [skillFilesCheck(["update"]), allowRuleCheck("update")];
