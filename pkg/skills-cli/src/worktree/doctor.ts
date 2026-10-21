import {
	allowRuleCheck,
	gitCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

const MIN_GIT_WORKTREE_REMOVE = "2.17.0";

export const worktreeChecks: DoctorCheck[] = [
	skillFilesCheck(["worktree"]),
	gitCheck(MIN_GIT_WORKTREE_REMOVE),
	allowRuleCheck("worktree"),
];
