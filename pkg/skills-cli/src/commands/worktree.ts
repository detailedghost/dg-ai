import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";
import { main } from "../worktree";

/** Register worktree with its raw parser so bare usage keeps exit 1 and failures exit 2. */
export function registerWorktree(program: Command): void {
	registerRawCommand(program, {
		name: "worktree",
		description:
			"Create, list, remove and prune git worktrees for agent workflows",
		run: main,
	});
}
