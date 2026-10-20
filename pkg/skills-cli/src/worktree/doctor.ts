import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const worktreeChecks: DoctorCheck[] = [
	skillFilesCheck(["worktree"]),
	gitCheck("2.17.0"),
	allowRuleCheck("worktree"),
];
