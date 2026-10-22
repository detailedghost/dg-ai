import { allowRuleCheck, skillFilesCheck } from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const syncChecks: DoctorCheck[] = [
	skillFilesCheck(["sync", "copilot-sync", "opencode-sync", "codex-sync", "claude-sync"]),
	allowRuleCheck("sync"),
];
