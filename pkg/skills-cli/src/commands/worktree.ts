import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register worktree with its raw parser so bare usage keeps exit 1 and failures exit 2. */
export function registerWorktree(program: Command): void {
	registerLazyRaw(program, {
		name: "worktree",
		description: "Create, list, remove and prune git worktrees for agent workflows",
		load: () => import("../worktree"),
	});
}
