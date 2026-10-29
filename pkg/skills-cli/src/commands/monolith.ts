import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register monolith without touching the filesystem or loading skill assets. */
export function registerMonolith(program: Command): void {
	registerLazyRaw(program, {
		name: "monolith",
		description: "Vocabulary helper and worktree scan generator for the monolith skill",
		load: () => import("../monolith"),
	});
}
