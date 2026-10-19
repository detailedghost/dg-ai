import type { Command } from "commander";
import { main } from "../monolith";
import { registerRawCommand } from "../utils/legacy-command";

/** Register monolith without touching the filesystem or loading skill assets. */
export function registerMonolith(program: Command): void {
	registerRawCommand(program, {
		name: "monolith",
		description:
			"Vocabulary helper and worktree scan generator for the monolith skill",
		run: main,
	});
}
