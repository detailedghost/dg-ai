import type { Command } from "commander";
import { main } from "../catchup";
import { registerRawCommand } from "../utils/legacy-command";

/** Register the raw catchup parser without accessing Git or project files. */
export function registerCatchup(program: Command): void {
	registerRawCommand(program, {
		name: "catchup",
		description: "Rebase onto origin's default branch, verify, and push",
		run: main,
	});
}
